import { Args, Mutation, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    DefaultOrderPlacedStrategy,
    Permission,
    PluginCommonModule,
    RequestContext,
    VendurePlugin,
} from '@vendure/core';
import gql from 'graphql-tag';

import { LeadNotificationService } from './lead-notification.service';
import { LeadOrderEventGuard } from './lead-order-event-guard';
import { LeadOrderInterceptor } from './lead-order-interceptor';
import { LeadOrderSaveGuard } from './lead-order-save-guard';
import { LeadOrderService, leadTransitions, SubmitLeadInput } from './lead-order.service';
import { LeadSubmission } from './lead-submission.entity';

declare module '@vendure/core' {
    interface OrderStates {
        LeadSubmitted: never;
    }
}

@Resolver()
export class LeadOrderResolver {
    constructor(private leads: LeadOrderService) {}
    @Mutation()
    @Allow(Permission.Owner)
    prepareLeadOrder(@Ctx() ctx: RequestContext) {
        return this.leads.prepare(ctx);
    }
    @Mutation()
    @Allow(Permission.Owner)
    submitLeadOrder(@Ctx() ctx: RequestContext, @Args('input') input: SubmitLeadInput) {
        return this.leads.submit(ctx, input);
    }
}

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [LeadSubmission],
    providers: [LeadOrderService, LeadNotificationService, LeadOrderEventGuard, LeadOrderSaveGuard],
    shopApiExtensions: {
        resolvers: [LeadOrderResolver],
        schema: gql`
            type LeadSession {
                sessionCapability: String!
            }
            input LeadItemInput {
                productVariantId: ID!
                quantity: Int!
            }
            input LeadContactInput {
                fullName: String!
                phone: String!
            }
            input SubmitLeadOrderInput {
                sessionCapability: String!
                submissionToken: String!
                items: [LeadItemInput!]!
                contact: LeadContactInput!
            }
            type LeadOrderLine {
                productVariantId: ID!
                quantity: Int!
                unitPriceWithTax: Int!
                linePriceWithTax: Int!
            }
            type LeadOrderReceipt {
                orderId: ID!
                code: String!
                currencyCode: String!
                totalWithTax: Int!
                lines: [LeadOrderLine!]!
            }
            extend type Mutation {
                prepareLeadOrder: LeadSession!
                submitLeadOrder(input: SubmitLeadOrderInput!): LeadOrderReceipt!
            }
        `,
    },
    configuration: config => {
        config.customFields.Order ??= [];
        config.customFields.Order.push({
            name: 'leadOriginChannel',
            type: 'string',
            nullable: true,
            internal: true,
        });
        config.orderOptions.orderInterceptors.push(new LeadOrderInterceptor());
        config.orderOptions.process.push({
            transitions: { AddingItems: { to: ['LeadSubmitted'] }, LeadSubmitted: { to: [] } },
            onTransitionStart: (_from, to, { ctx }) => {
                if (to === 'LeadSubmitted' && !leadTransitions.has(ctx))
                    return 'LEAD_DEDICATED_SUBMISSION_REQUIRED';
            },
        });
        const previous = config.orderOptions.orderPlacedStrategy ?? new DefaultOrderPlacedStrategy();
        config.orderOptions.orderPlacedStrategy = {
            init: injector => previous.init?.(injector),
            destroy: () => previous.destroy?.(),
            shouldSetAsPlaced: (ctx, from, to, order) =>
                to === 'LeadSubmitted' || previous.shouldSetAsPlaced(ctx, from, to, order),
        };
        return config;
    },
})
export class LeadOrderPlugin {}
