export const ORDER_EMAIL_SENT = 'ORDER_EMAIL_SENT';

declare module '@vendure/core' {
    interface OrderHistoryEntryData {
        [ORDER_EMAIL_SENT]: {
            emailType: string;
            success: boolean;
            from: string;
            recipient: string;
            cc?: string | null;
            bcc?: string | null;
            replyTo?: string | null;
            subject: string;
            body: string;
            metadata?: Record<string, unknown> | null;
            error?: string | null;
            sentAt: string;
        };
    }
}
