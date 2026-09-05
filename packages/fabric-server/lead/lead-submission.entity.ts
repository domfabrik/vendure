import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

export interface LeadReceipt {
    orderId: string;
    code: string;
    currencyCode: string;
    totalWithTax: number;
    lines: Array<{
        productVariantId: string;
        quantity: number;
        unitPriceWithTax: number;
        linePriceWithTax: number;
    }>;
}

export interface LeadAttemptedEnvelope {
    from: string;
    to: string;
    cc: string | null;
    subject: string;
    messageId: string;
}

/** No raw session or submission tokens are retained. The receipt is immutable after commit. */
@Entity()
@Index('UQ_lead_submission_scope_token', ['channelId', 'sessionId', 'tokenHash'], { unique: true })
export class LeadSubmission extends VendureEntity {
    constructor(input?: DeepPartial<LeadSubmission>) {
        super(input);
    }
    @Column() channelId: string;
    @Column() sessionId: string;
    @Column({ length: 64 }) tokenHash: string;
    @Column({ length: 64 }) fingerprint: string;
    @Index('UQ_lead_submission_order', { unique: true })
    @Column()
    orderId: string;
    @Column('jsonb') receipt: LeadReceipt;
    @Column('jsonb') contact: { fullName: string; phone: string };
    @Column('text') notificationBody: string;
    @Column({ default: 'pending' }) notificationState: string;
    @Column({ type: 'timestamp', nullable: true }) attemptedAt: Date | null;
    @Column({ type: 'jsonb', nullable: true }) attemptedEnvelope: LeadAttemptedEnvelope | null;
}
