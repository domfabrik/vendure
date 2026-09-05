import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
    Channel,
    HistoryService,
    Logger,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';

import { ORDER_EMAIL_SENT } from '../email/email-history.types';

import { LeadAttemptedEnvelope, LeadSubmission } from './lead-submission.entity';

type DeliveryState = 'sent' | 'failed' | 'ambiguous';
export interface LeadEmail {
    from: string;
    to: string;
    cc?: string;
    subject: string;
    html: string;
    messageId: string;
}

/** Persistent, single-attempt outbox. An ambiguous SMTP result requires operator reconciliation. */
@Injectable()
export class LeadNotificationService implements OnApplicationBootstrap, OnModuleDestroy {
    private timer?: ReturnType<typeof setInterval>;
    private running = false;
    constructor(
        private connection: TransactionalConnection,
        private contexts: RequestContextService,
        private history: HistoryService,
    ) {}

    onApplicationBootstrap() {
        this.timer = setInterval(() => {
            void this.tick().catch(() =>
                Logger.error('Lead notification processing failed', 'LeadNotification'),
            );
        }, 5000);
        this.timer.unref();
    }
    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    async tick() {
        if (this.running) return;
        this.running = true;
        try {
            await this.reconcileStaleAttempts();
            const transport = this.transport();
            // Disabled delivery leaves the durable notification pending, including local validation.
            if (!transport) return;
            const submission = await this.connection.rawConnection.transaction(async manager => {
                const repo = manager.getRepository(LeadSubmission);
                const next = await repo
                    .createQueryBuilder('lead')
                    .where('lead.notificationState = :state', { state: 'pending' })
                    .orderBy('lead.id', 'ASC')
                    .take(1)
                    .setLock('pessimistic_write')
                    .setOnLocked('skip_locked')
                    .getOne();
                if (!next) return;
                next.notificationState = 'attempting';
                next.attemptedAt = new Date();
                next.attemptedEnvelope = this.envelope(next);
                return repo.save(next);
            });
            if (!submission) return;
            const email = this.email(submission);
            let state: DeliveryState = 'sent';
            try {
                await transport(email);
            } catch (error) {
                // SMTP negative replies are definitive failures. Socket/timeout/ack failures are ambiguous.
                const responseCode = (error as { responseCode?: number })?.responseCode;
                state = typeof responseCode === 'number' && responseCode >= 400 ? 'failed' : 'ambiguous';
            }
            await this.finish(submission, state);
        } finally {
            this.running = false;
        }
    }

    protected transport(): ((email: LeadEmail) => Promise<unknown>) | undefined {
        const {
            ORDER_NOTIFICATION_RECIPIENT,
            EMAIL_SMTP_HOST,
            EMAIL_SMTP_USER,
            EMAIL_SMTP_PASSWORD,
            EMAIL_FROM_ADDRESS,
        } = process.env;
        if (
            !ORDER_NOTIFICATION_RECIPIENT ||
            !EMAIL_SMTP_HOST ||
            !EMAIL_SMTP_USER ||
            !EMAIL_SMTP_PASSWORD ||
            !EMAIL_FROM_ADDRESS
        )
            return;
        const port = Number(process.env.EMAIL_SMTP_PORT ?? 465);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return;
        const smtp = nodemailer.createTransport({
            host: EMAIL_SMTP_HOST,
            port,
            secure:
                process.env.EMAIL_SMTP_SECURE == null
                    ? port === 465
                    : /^(true|1|yes)$/i.test(process.env.EMAIL_SMTP_SECURE),
            auth: { user: EMAIL_SMTP_USER, pass: EMAIL_SMTP_PASSWORD },
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 60000,
            logger: false,
            debug: false,
        });
        return async email => {
            const info = await smtp.sendMail(email);
            // Partial acceptance is not full notification success, including operator rejection with CC accepted.
            if (!info.accepted?.length || info.rejected?.length)
                throw Object.assign(new Error('SMTP rejected'), { responseCode: 550 });
        };
    }

    private envelope(submission: LeadSubmission): LeadAttemptedEnvelope {
        const receipt = submission.receipt;
        const identity = `${submission.channelId}:${submission.sessionId}:${submission.tokenHash}:${receipt.code}`;
        const messageHash = createHash('sha256').update(identity).digest('hex');
        return {
            from: process.env.EMAIL_FROM_ADDRESS ?? '',
            to: process.env.ORDER_NOTIFICATION_RECIPIENT ?? '',
            cc:
                process.env.ORDER_NOTIFICATION_CC_RECIPIENTS?.split(/[;,\n]/)
                    .map(s => s.trim())
                    .filter(Boolean)
                    .join(', ') || null,
            subject: `Новая заявка #${receipt.code}`,
            messageId: `<fabric-lead-${messageHash}@domfabrik.ru>`,
        };
    }

    protected email(submission: LeadSubmission): LeadEmail {
        const envelope = submission.attemptedEnvelope;
        if (!envelope) throw new Error('Attempted lead envelope unavailable');
        return { ...envelope, cc: envelope.cc ?? undefined, html: submission.notificationBody };
    }

    async reconcileStaleAttempts() {
        // Ten minutes exceeds all SMTP timeouts. A surviving worker must never re-send a claimed notification.
        const stale = await this.connection.rawConnection
            .getRepository(LeadSubmission)
            .createQueryBuilder('lead')
            .where('lead.notificationState = :state AND lead.attemptedAt < :cutoff', {
                state: 'attempting',
                cutoff: new Date(Date.now() - 600000),
            })
            .take(100)
            .getMany();
        for (const submission of stale) await this.finish(submission, 'ambiguous');
    }

    private async finish(submission: LeadSubmission, state: DeliveryState) {
        const channel = await this.connection.rawConnection
            .getRepository(Channel)
            .findOneByOrFail({ id: submission.channelId });
        const ctx = await this.contexts.create({ apiType: 'admin', channelOrToken: channel });
        await this.connection.withTransaction(ctx, async tx => {
            const repo = this.connection.getRepository(tx, LeadSubmission);
            const current = await repo
                .createQueryBuilder('lead')
                .where('lead.id = :id', { id: submission.id })
                .setLock('pessimistic_write')
                .getOneOrFail();
            if (current.notificationState !== 'attempting') return;
            // Older claimed rows cannot truthfully recover their original envelope from today's configuration.
            const email = current.attemptedEnvelope
                ? this.email(current)
                : {
                      from: '[original envelope unavailable]',
                      to: '[original envelope unavailable]',
                      cc: undefined,
                      subject: '[original envelope unavailable]',
                      messageId: '[original envelope unavailable]',
                      html: current.notificationBody,
                  };
            await this.history.createHistoryEntryForOrder({
                ctx: tx,
                orderId: submission.orderId,
                type: ORDER_EMAIL_SENT,
                data: {
                    emailType: 'lead-order-notification',
                    success: state === 'sent',
                    from: email.from,
                    recipient: email.to,
                    cc: email.cc ?? null,
                    subject: email.subject,
                    body: email.html,
                    metadata: {
                        submissionId: String(submission.id),
                        deliveryState: state,
                        messageId: email.messageId,
                        attemptedEnvelopeStatus: current.attemptedEnvelope ? 'recorded' : 'unavailable',
                    },
                    error:
                        state === 'sent'
                            ? null
                            : state === 'ambiguous'
                              ? 'DELIVERY_AMBIGUOUS_MANUAL_RECONCILIATION_REQUIRED'
                              : 'SMTP_REJECTED',
                    sentAt: new Date().toISOString(),
                },
            });
            current.notificationState = state;
            await repo.save(current);
        });
    }
}
