import { Injectable } from '@nestjs/common';
import { RequestContext, Session, TransactionalConnection, UserInputError } from '@vendure/core';
import { randomInt, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import {
    BundleExpectations,
    canonicalJson,
    isDescriptionStudyBundleComplete,
    productionBundleExpectations,
    sha256Utf8,
    validateDescriptionStudyBundle,
} from './description-study.bundle';
import {
    DescriptionSelectedVersion,
    DescriptionStudyBallot,
    DescriptionStudyCandidate,
    DescriptionStudyParticipant,
    DescriptionVersion,
    DescriptionVoteChoice,
} from './description-study.entity';

const TEST_PUBLIC_URL = 'https://test.domfabrik.ru';
const choices = new Set<DescriptionVoteChoice>(['LEFT', 'RIGHT', 'EQUAL', 'SKIP']);

export interface DescriptionComparisonVoteInput {
    ballotToken: string;
    studySessionId?: string;
    choice: DescriptionVoteChoice;
    leftComment?: string;
    rightComment?: string;
}

export class DescriptionStudyError extends UserInputError {
    constructor(code: string) {
        super(code);
    }
}

export function descriptionStudyEnabled(publicUrl = process.env.VENDURE_PUBLIC_URL): boolean {
    return (publicUrl ?? '').trim() === TEST_PUBLIC_URL;
}

export function participantKey(experimentKey: string, sessionId: string | number): string {
    return sha256Utf8(`${experimentKey}:${String(sessionId)}`);
}

export function normalizeStudySessionId(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (
        typeof value !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    )
        throw new DescriptionStudyError('DESCRIPTION_STUDY_INVALID_SESSION_ID');
    return value.toLowerCase();
}

@Injectable()
export class DescriptionStudyService {
    constructor(private connection: TransactionalConnection) {}

    private ensureEnabled(): void {
        if (!descriptionStudyEnabled()) throw new DescriptionStudyError('DESCRIPTION_STUDY_UNAVAILABLE');
    }

    private ensureExperimentKey(value: unknown): asserts value is string {
        if (typeof value !== 'string' || value.length < 1 || value.length > 200)
            throw new DescriptionStudyError('DESCRIPTION_STUDY_INVALID_EXPERIMENT');
    }

    async syncBundle(
        ctx: RequestContext,
        rawBundle: unknown,
        expectations: BundleExpectations = productionBundleExpectations,
    ): Promise<{ inserted: number; existing: number }> {
        this.ensureEnabled();
        const bundle = validateDescriptionStudyBundle(rawBundle, expectations);
        return this.connection.withTransaction(ctx, async tx => {
            const repository = this.connection.getRepository(tx, DescriptionStudyCandidate);
            await repository.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
                'description-study-bundle',
                `${String(ctx.channelId)}:${bundle.experimentKey}`,
            ]);
            const scope = { channelId: String(ctx.channelId), experimentKey: bundle.experimentKey };
            const existing = await repository.find({ where: scope, order: { ordinal: 'ASC' } });
            if (!isDescriptionStudyBundleComplete(bundle)) {
                if (existing.length > 0)
                    throw new DescriptionStudyError('DESCRIPTION_STUDY_INCOMPLETE_BUNDLE_CONFLICT');
                return { inserted: 0, existing: 0 };
            }
            if (existing.length > 0) {
                if (existing.length !== bundle.cases.length)
                    throw new DescriptionStudyError('DESCRIPTION_STUDY_DATASET_CHANGED');
                for (let index = 0; index < existing.length; index++) {
                    const stored = existing[index];
                    const item = bundle.cases[index];
                    const equal =
                        stored.sourceProductId === item.sourceProductId &&
                        stored.slug === item.slug &&
                        stored.productName === item.productName &&
                        stored.imageUrl === item.imageUrl &&
                        stored.sourceUrl === item.sourceUrl &&
                        stored.sourceKind === item.sourceKind &&
                        canonicalJson(stored.parsedCharacteristics) ===
                            canonicalJson(item.parsedCharacteristics) &&
                        stored.ordinal === item.ordinal &&
                        stored.oldText === item.oldText &&
                        stored.newText === item.newText &&
                        stored.oldHash === item.oldHash &&
                        stored.newHash === item.newHash &&
                        stored.oldVersionId === item.oldVersionId &&
                        stored.newVersionId === item.newVersionId &&
                        stored.oldEmpty === item.oldEmpty &&
                        stored.vendorName === item.vendorName &&
                        stored.productType === item.productType &&
                        stored.sourceSnapshotSha256 === bundle.sourceSnapshotSha256 &&
                        stored.schemaVersion === bundle.schemaVersion &&
                        canonicalJson(stored.generationMetadata) === canonicalJson(item.generationMetadata);
                    if (!equal) throw new DescriptionStudyError('DESCRIPTION_STUDY_DATASET_CHANGED');
                }
                return { inserted: 0, existing: existing.length };
            }
            const candidates = bundle.cases.map(item => {
                const candidate = new DescriptionStudyCandidate();
                Object.assign(candidate, {
                    ...item,
                    channelId: scope.channelId,
                    experimentKey: scope.experimentKey,
                    sourceSnapshotSha256: bundle.sourceSnapshotSha256,
                    schemaVersion: bundle.schemaVersion,
                });
                return candidate;
            });
            await repository.save(candidates, { chunk: 100 });
            return { inserted: candidates.length, existing: 0 };
        });
    }

    async prepare(ctx: RequestContext, experimentKey: string, studySessionId?: string) {
        this.ensureEnabled();
        this.ensureExperimentKey(experimentKey);
        const requestedId = normalizeStudySessionId(studySessionId);
        const activeSession = ctx.session;
        if (!activeSession) throw new DescriptionStudyError('DESCRIPTION_STUDY_SESSION_REQUIRED');
        return this.connection.withTransaction(ctx, async tx => {
            const session = await this.connection
                .getRepository(tx, Session)
                .createQueryBuilder('session')
                .where('session.id = :id', { id: activeSession.id })
                .setLock('pessimistic_write')
                .getOne();
            if (!session || session.invalidated || session.expires <= new Date())
                throw new DescriptionStudyError('DESCRIPTION_STUDY_SESSION_REQUIRED');
            const channelId = String(ctx.channelId);
            const identity = await this.resolveOwner(
                tx,
                experimentKey,
                participantKey(experimentKey, session.id),
                requestedId,
            );
            const owner = identity.participantKey;
            const ballotRepository = this.connection.getRepository(tx, DescriptionStudyBallot);
            const candidateRepository = this.connection.getRepository(tx, DescriptionStudyCandidate);
            const pending = await ballotRepository
                .createQueryBuilder('ballot')
                .innerJoinAndSelect('ballot.candidate', 'candidate')
                .where('ballot.channelId = :channelId', { channelId })
                .andWhere('ballot.experimentKey = :experimentKey', { experimentKey })
                .andWhere('ballot.participantKey = :owner', { owner })
                .andWhere('ballot.votedAt IS NULL')
                .orderBy('ballot.id', 'ASC')
                .getOne();
            const completed = await ballotRepository
                .createQueryBuilder('ballot')
                .where('ballot.channelId = :channelId', { channelId })
                .andWhere('ballot.experimentKey = :experimentKey', { experimentKey })
                .andWhere('ballot.participantKey = :owner', { owner })
                .andWhere('ballot.votedAt IS NOT NULL')
                .getCount();
            const total = await candidateRepository.count({ where: { channelId, experimentKey } });
            if (pending) return this.comparison('READY', pending, completed, total, identity.studySessionId);
            if (total === 0)
                return this.comparison('UNAVAILABLE', null, completed, 0, identity.studySessionId);

            const unseen = await candidateRepository
                .createQueryBuilder('candidate')
                .select('candidate.id', 'id')
                .where('candidate.channelId = :channelId', { channelId })
                .andWhere('candidate.experimentKey = :experimentKey', { experimentKey })
                .andWhere(query => {
                    const seen = query
                        .subQuery()
                        .select('1')
                        .from(DescriptionStudyBallot, 'seen')
                        .where('seen.candidateId = candidate.id')
                        .andWhere('seen.channelId = :channelId')
                        .andWhere('seen.experimentKey = :experimentKey')
                        .andWhere('seen.participantKey = :owner')
                        .getQuery();
                    return `NOT EXISTS ${seen}`;
                })
                .setParameter('owner', owner)
                .orderBy('candidate.id', 'ASC')
                .getRawMany<{ id: number }>();
            if (unseen.length === 0)
                return this.comparison('COMPLETE', null, completed, total, identity.studySessionId);
            const candidate = await candidateRepository.findOneByOrFail({
                id: unseen[randomInt(unseen.length)].id,
            });
            const ballot = await ballotRepository.save(
                new DescriptionStudyBallot({
                    ballotToken: randomUUID(),
                    channelId,
                    experimentKey,
                    participantKey: owner,
                    studySessionId: identity.studySessionId,
                    candidateId: Number(candidate.id),
                    leftVersion: randomInt(2) === 0 ? 'OLD' : 'NEW',
                    choice: null,
                    selectedVersion: null,
                    leftComment: '',
                    rightComment: '',
                    assignedAt: new Date(),
                    votedAt: null,
                }),
            );
            ballot.candidate = candidate;
            return this.comparison('READY', ballot, completed, total, identity.studySessionId);
        });
    }

    async submit(ctx: RequestContext, rawInput: DescriptionComparisonVoteInput) {
        this.ensureEnabled();
        const input = this.validateVote(rawInput);
        const activeSession = ctx.session;
        if (!activeSession) throw new DescriptionStudyError('DESCRIPTION_STUDY_SESSION_REQUIRED');
        return this.connection.withTransaction(ctx, async tx => {
            const session = await this.connection
                .getRepository(tx, Session)
                .createQueryBuilder('session')
                .where('session.id = :id', { id: activeSession.id })
                .setLock('pessimistic_write')
                .getOne();
            if (!session || session.invalidated || session.expires <= new Date())
                throw new DescriptionStudyError('DESCRIPTION_STUDY_SESSION_REQUIRED');
            const repository = this.connection.getRepository(tx, DescriptionStudyBallot);
            const initial = await repository.findOne({
                where: { ballotToken: input.ballotToken, channelId: String(ctx.channelId) },
            });
            if (!initial) throw new DescriptionStudyError('DESCRIPTION_STUDY_BALLOT_NOT_FOUND');
            const identity = await this.resolveOwner(
                tx,
                initial.experimentKey,
                participantKey(initial.experimentKey, session.id),
                input.studySessionId,
            );
            const ballot = await repository
                .createQueryBuilder('ballot')
                .innerJoinAndSelect('ballot.candidate', 'candidate')
                .where('ballot.ballotToken = :token', { token: input.ballotToken })
                .andWhere('ballot.channelId = :channelId', { channelId: String(ctx.channelId) })
                .setLock('pessimistic_write')
                .getOne();
            if (!ballot || ballot.participantKey !== identity.participantKey)
                throw new DescriptionStudyError('DESCRIPTION_STUDY_BALLOT_NOT_FOUND');
            if (ballot.votedAt) {
                if (
                    ballot.choice !== input.choice ||
                    ballot.leftComment !== input.leftComment ||
                    ballot.rightComment !== input.rightComment
                ) {
                    throw new DescriptionStudyError('DESCRIPTION_STUDY_VOTE_CONFLICT');
                }
                return {
                    saved: true,
                    duplicate: true,
                    completed: await this.completed(repository, ballot),
                };
            }
            ballot.choice = input.choice;
            ballot.leftComment = input.leftComment;
            ballot.rightComment = input.rightComment;
            ballot.selectedVersion = this.selectedVersion(input.choice, ballot.leftVersion);
            ballot.votedAt = new Date();
            await repository.save(ballot);
            return { saved: true, duplicate: false, completed: await this.completed(repository, ballot) };
        });
    }

    // Serialize identity adoption and recovery within the experiment, including legacy requests.
    private async lockIdentity(ctx: RequestContext, experimentKey: string) {
        await this.connection
            .getRepository(ctx, DescriptionStudyParticipant)
            .query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
                'description-study-identity',
                `${String(ctx.channelId)}:${experimentKey}`,
            ]);
    }

    private async resolveOwner(
        ctx: RequestContext,
        experimentKey: string,
        legacyOwner: string,
        requestedId?: string,
    ) {
        await this.lockIdentity(ctx, experimentKey);
        const repository = this.connection.getRepository(ctx, DescriptionStudyParticipant);
        const scope = { channelId: String(ctx.channelId), experimentKey };
        let identity = requestedId
            ? await repository.findOne({ where: { ...scope, studySessionId: requestedId } })
            : null;
        if (!identity)
            identity = await repository.findOne({ where: { ...scope, participantKey: legacyOwner } });
        if (!identity && requestedId)
            identity = await repository.save(
                new DescriptionStudyParticipant({
                    ...scope,
                    participantKey: legacyOwner,
                    studySessionId: requestedId,
                }),
            );
        const owner = identity?.participantKey ?? legacyOwner;
        await repository.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
            'description-study-owner',
            `${scope.channelId}:${experimentKey}:${owner}`,
        ]);
        if (identity) await this.backfill(ctx, scope, owner, identity.studySessionId);
        return { participantKey: owner, studySessionId: identity?.studySessionId ?? null };
    }

    private async backfill(
        ctx: RequestContext,
        scope: { channelId: string; experimentKey: string },
        owner: string,
        id: string,
    ) {
        // Preserve updatedAt as well as every historical vote payload field.
        await this.connection
            .getRepository(ctx, DescriptionStudyBallot)
            .createQueryBuilder()
            .update()
            .set({ studySessionId: () => ':studySessionId', updatedAt: () => '"updatedAt"' })
            .where(
                '"channelId" = :channelId AND "experimentKey" = :experimentKey AND "participantKey" = :owner',
            )
            .andWhere('"studySessionId" IS DISTINCT FROM :studySessionId')
            .setParameters({ ...scope, owner, studySessionId: id })
            .execute();
    }

    async recoverDotSession(
        ctx: RequestContext,
        experimentKey: string,
        studySessionId: string,
        dryRun = true,
    ) {
        this.ensureEnabled();
        this.ensureExperimentKey(experimentKey);
        const id = normalizeStudySessionId(studySessionId);
        if (!id) throw new DescriptionStudyError('DESCRIPTION_STUDY_INVALID_SESSION_ID');
        return this.connection.withTransaction(ctx, async tx => {
            await this.lockIdentity(tx, experimentKey);
            const scope = { channelId: String(ctx.channelId), experimentKey };
            const ballots = this.connection.getRepository(tx, DescriptionStudyBallot);
            const all = await ballots.find({ where: scope, order: { id: 'ASC' } });
            const marked = (ballot: DescriptionStudyBallot) =>
                /проверка\s+dot\s*\(ИИ\)/i.test(ballot.leftComment) ||
                /проверка\s+dot\s*\(ИИ\)/i.test(ballot.rightComment);
            const owners = [...new Set(all.filter(marked).map(ballot => ballot.participantKey))];
            if (owners.length !== 1) throw new DescriptionStudyError('DESCRIPTION_STUDY_RECOVERY_AMBIGUOUS');
            const owner = owners[0];
            const owned = all.filter(ballot => ballot.participantKey === owner);
            if (owned.some(ballot => ballot.votedAt && !marked(ballot)))
                throw new DescriptionStudyError('DESCRIPTION_STUDY_RECOVERY_UNMARKED_VOTES');
            const participants = this.connection.getRepository(tx, DescriptionStudyParticipant);
            await participants.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
                'description-study-owner',
                `${scope.channelId}:${experimentKey}:${owner}`,
            ]);
            const byId = await participants.findOne({ where: { ...scope, studySessionId: id } });
            const byOwner = await participants.findOne({ where: { ...scope, participantKey: owner } });
            if (
                (byId && byId.participantKey !== owner) ||
                (byOwner && byOwner.studySessionId !== id) ||
                owned.some(ballot => ballot.studySessionId && ballot.studySessionId !== id)
            )
                throw new DescriptionStudyError('DESCRIPTION_STUDY_RECOVERY_CONFLICT');
            const backfilled = owned.filter(ballot => ballot.studySessionId !== id).length;
            if (!dryRun) {
                if (!byOwner)
                    await participants.save(
                        new DescriptionStudyParticipant({
                            ...scope,
                            participantKey: owner,
                            studySessionId: id,
                        }),
                    );
                await this.backfill(tx, scope, owner, id);
            }
            return {
                dryRun,
                participantKey: owner,
                studySessionId: id,
                ballots: owned.length,
                submitted: owned.filter(ballot => ballot.votedAt).length,
                pending: owned.filter(ballot => !ballot.votedAt).length,
                backfilled,
                responseIds: owned.filter(ballot => ballot.votedAt).map(ballot => String(ballot.id)),
            };
        });
    }

    async stats(ctx: RequestContext, experimentKey: string) {
        this.ensureEnabled();
        this.ensureExperimentKey(experimentKey);
        const channelId = String(ctx.channelId);
        const candidates = await this.connection.rawConnection.getRepository(DescriptionStudyCandidate).find({
            where: { channelId, experimentKey },
            order: { ordinal: 'ASC' },
        });
        const ballots = await this.connection.rawConnection.getRepository(DescriptionStudyBallot).find({
            where: { channelId, experimentKey },
        });
        const submitted = ballots.filter(ballot => ballot.votedAt !== null);
        const count = (selected: DescriptionSelectedVersion) =>
            submitted.filter(ballot => ballot.selectedVersion === selected).length;
        const oldWins = count('OLD');
        const newWins = count('NEW');
        return {
            experimentKey,
            totalCandidates: candidates.length,
            assigned: ballots.length,
            submitted: submitted.length,
            participants: new Set(ballots.map(ballot => ballot.participantKey)).size,
            oldWins,
            newWins,
            equal: count('EQUAL'),
            skipped: count('SKIP'),
            leftWins: submitted.filter(ballot => ballot.choice === 'LEFT').length,
            rightWins: submitted.filter(ballot => ballot.choice === 'RIGHT').length,
            newOnLeft: ballots.filter(ballot => ballot.leftVersion === 'NEW').length,
            newOnRight: ballots.filter(ballot => ballot.leftVersion === 'OLD').length,
            products: candidates.map(candidate => {
                const productBallots = submitted.filter(
                    ballot => Number(ballot.candidateId) === Number(candidate.id),
                );
                const productCount = (selected: DescriptionSelectedVersion) =>
                    productBallots.filter(ballot => ballot.selectedVersion === selected).length;
                return {
                    productId: candidate.sourceProductId,
                    slug: candidate.slug,
                    productName: candidate.productName,
                    oldVersionId: candidate.oldVersionId,
                    newVersionId: candidate.newVersionId,
                    oldHash: candidate.oldHash,
                    newHash: candidate.newHash,
                    oldEmpty: candidate.oldEmpty,
                    submitted: productBallots.length,
                    oldWins: productCount('OLD'),
                    newWins: productCount('NEW'),
                    equal: productCount('EQUAL'),
                    skipped: productCount('SKIP'),
                };
            }),
        };
    }

    async responses(ctx: RequestContext, experimentKey: string, skip = 0, take = 100) {
        this.ensureEnabled();
        this.ensureExperimentKey(experimentKey);
        if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(take) || take < 1 || take > 200)
            throw new DescriptionStudyError('DESCRIPTION_STUDY_INVALID_PAGE');
        const query = this.connection.rawConnection
            .getRepository(DescriptionStudyBallot)
            .createQueryBuilder('ballot')
            .innerJoinAndSelect('ballot.candidate', 'candidate')
            .where('ballot.channelId = :channelId', { channelId: String(ctx.channelId) })
            .andWhere('ballot.experimentKey = :experimentKey', { experimentKey })
            .andWhere('ballot.votedAt IS NOT NULL')
            .orderBy('ballot.votedAt', 'ASC')
            .addOrderBy('ballot.id', 'ASC')
            .skip(skip)
            .take(take);
        const [items, totalItems] = await query.getManyAndCount();
        return { totalItems, items: items.map(ballot => this.responseRow(ballot)) };
    }

    private comparison(
        status: 'READY' | 'COMPLETE' | 'UNAVAILABLE',
        ballot: DescriptionStudyBallot | null,
        completed: number,
        total: number,
        studySessionId: string | null,
    ) {
        const candidate = ballot?.candidate;
        const leftIsOld = ballot?.leftVersion === 'OLD';
        return {
            status,
            studySessionId,
            ballotToken: ballot?.ballotToken ?? null,
            productId: candidate?.sourceProductId ?? null,
            slug: candidate?.slug ?? null,
            productName: candidate?.productName ?? null,
            imageUrl: candidate?.imageUrl ?? null,
            sourceUrl: candidate?.sourceUrl ?? null,
            sourceKind: candidate?.sourceKind ?? null,
            parsedCharacteristics: candidate?.parsedCharacteristics ?? [],
            leftText: candidate ? (leftIsOld ? candidate.oldText : candidate.newText) : null,
            rightText: candidate ? (leftIsOld ? candidate.newText : candidate.oldText) : null,
            completed,
            total,
        };
    }

    private validateVote(raw: DescriptionComparisonVoteInput) {
        if (
            !raw ||
            typeof raw.ballotToken !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.ballotToken) ||
            !choices.has(raw.choice)
        ) {
            throw new DescriptionStudyError('DESCRIPTION_STUDY_INVALID_VOTE');
        }
        const leftComment = raw.leftComment ?? '';
        const rightComment = raw.rightComment ?? '';
        if (
            typeof leftComment !== 'string' ||
            typeof rightComment !== 'string' ||
            leftComment.length > 2000 ||
            rightComment.length > 2000
        ) {
            throw new DescriptionStudyError('DESCRIPTION_STUDY_INVALID_COMMENT');
        }
        return {
            studySessionId: normalizeStudySessionId(raw.studySessionId),
            ballotToken: raw.ballotToken.toLowerCase(),
            choice: raw.choice,
            leftComment,
            rightComment,
        };
    }

    private selectedVersion(
        choice: DescriptionVoteChoice,
        leftVersion: DescriptionVersion,
    ): DescriptionSelectedVersion {
        if (choice === 'EQUAL' || choice === 'SKIP') return choice;
        if (choice === 'LEFT') return leftVersion;
        return leftVersion === 'OLD' ? 'NEW' : 'OLD';
    }

    private completed(repository: Repository<DescriptionStudyBallot>, ballot: DescriptionStudyBallot) {
        return repository
            .createQueryBuilder('completed')
            .where('completed.channelId = :channelId', { channelId: ballot.channelId })
            .andWhere('completed.experimentKey = :experimentKey', { experimentKey: ballot.experimentKey })
            .andWhere('completed.participantKey = :participantKey', {
                participantKey: ballot.participantKey,
            })
            .andWhere('completed.votedAt IS NOT NULL')
            .getCount();
    }

    private responseRow(ballot: DescriptionStudyBallot) {
        const candidate = ballot.candidate;
        const leftVersion = ballot.leftVersion;
        const rightVersion: DescriptionVersion = leftVersion === 'OLD' ? 'NEW' : 'OLD';
        return {
            responseId: String(ballot.id),
            participantKey: ballot.participantKey,
            studySessionId: ballot.studySessionId,
            productId: candidate.sourceProductId,
            slug: candidate.slug,
            productName: candidate.productName,
            oldVersionId: candidate.oldVersionId,
            newVersionId: candidate.newVersionId,
            oldHash: candidate.oldHash,
            newHash: candidate.newHash,
            leftVersion,
            rightVersion,
            choice: ballot.choice,
            selectedVersion: ballot.selectedVersion,
            leftComment: ballot.leftComment,
            rightComment: ballot.rightComment,
            oldComment: leftVersion === 'OLD' ? ballot.leftComment : ballot.rightComment,
            newComment: leftVersion === 'NEW' ? ballot.leftComment : ballot.rightComment,
            assignedAt: ballot.assignedAt,
            votedAt: ballot.votedAt,
        };
    }
}
