import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { DescriptionCharacteristic, DescriptionSourceKind } from './description-study.bundle';

export type DescriptionVersion = 'OLD' | 'NEW';
export type DescriptionVoteChoice = 'LEFT' | 'RIGHT' | 'EQUAL' | 'SKIP';
export type DescriptionSelectedVersion = DescriptionVersion | 'EQUAL' | 'SKIP';

@Entity('description_study_candidate')
@Index('UQ_description_candidate_scope_product', ['channelId', 'experimentKey', 'sourceProductId'], {
    unique: true,
})
@Index('UQ_description_candidate_scope_ordinal', ['channelId', 'experimentKey', 'ordinal'], {
    unique: true,
})
export class DescriptionStudyCandidate extends VendureEntity {
    constructor(input?: DeepPartial<DescriptionStudyCandidate>) {
        super(input);
    }

    @Column() channelId: string;
    @Column() experimentKey: string;
    @Column() sourceProductId: string;
    @Column() slug: string;
    @Column() productName: string;
    @Column({ type: 'varchar', nullable: true }) imageUrl: string | null;
    @Column('text') sourceUrl: string;
    @Column('varchar') sourceKind: DescriptionSourceKind;
    @Column('jsonb') parsedCharacteristics: DescriptionCharacteristic[];
    @Column('integer') ordinal: number;
    @Column('text') oldText: string;
    @Column('text') newText: string;
    @Column({ length: 64 }) oldHash: string;
    @Column({ length: 64 }) newHash: string;
    @Column() oldVersionId: string;
    @Column() newVersionId: string;
    @Column('boolean') oldEmpty: boolean;
    @Column() vendorName: string;
    @Column() productType: string;
    @Column('jsonb') generationMetadata: Record<string, unknown>;
    @Column({ length: 64 }) sourceSnapshotSha256: string;
    @Column('integer') schemaVersion: number;
}

@Entity('description_study_ballot')
@Index('UQ_description_ballot_token', ['ballotToken'], { unique: true })
@Index(
    'UQ_description_ballot_scope_participant_candidate',
    ['channelId', 'experimentKey', 'participantKey', 'candidateId'],
    { unique: true },
)
@Index('IDX_description_ballot_participant_progress', [
    'channelId',
    'experimentKey',
    'participantKey',
    'votedAt',
])
export class DescriptionStudyBallot extends VendureEntity {
    constructor(input?: DeepPartial<DescriptionStudyBallot>) {
        super(input);
    }

    @Column('uuid') ballotToken: string;
    @Column() channelId: string;
    @Column() experimentKey: string;
    @Column({ length: 64 }) participantKey: string;
    @Column('uuid', { nullable: true }) studySessionId: string | null;
    @Column('integer') candidateId: number;
    @ManyToOne(() => DescriptionStudyCandidate, { nullable: false, onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'candidateId' })
    candidate: DescriptionStudyCandidate;
    @Column() leftVersion: DescriptionVersion;
    @Column({ type: 'varchar', nullable: true }) choice: DescriptionVoteChoice | null;
    @Column({ type: 'varchar', nullable: true }) selectedVersion: DescriptionSelectedVersion | null;
    @Column('text', { default: '' }) leftComment: string;
    @Column('text', { default: '' }) rightComment: string;
    @Column('timestamp') assignedAt: Date;
    @Column('timestamp', { nullable: true }) votedAt: Date | null;
}

@Entity('description_study_participant')
@Index('UQ_description_participant_scope_session', ['channelId', 'experimentKey', 'studySessionId'], {
    unique: true,
})
@Index('UQ_description_participant_scope_owner', ['channelId', 'experimentKey', 'participantKey'], {
    unique: true,
})
export class DescriptionStudyParticipant extends VendureEntity {
    constructor(input?: DeepPartial<DescriptionStudyParticipant>) {
        super(input);
    }
    @Column() channelId: string;
    @Column() experimentKey: string;
    @Column('uuid') studySessionId: string;
    @Column({ length: 64 }) participantKey: string;
}
