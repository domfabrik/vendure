import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, PluginCommonModule, RequestContext, VendurePlugin } from '@vendure/core';
import gql from 'graphql-tag';

import {
    DescriptionStudyBallot,
    DescriptionStudyCandidate,
    DescriptionStudyParticipant,
} from './description-study.entity';
import { DescriptionComparisonVoteInput, DescriptionStudyService } from './description-study.service';

@Resolver()
export class DescriptionStudyShopResolver {
    constructor(private study: DescriptionStudyService) {}

    @Mutation()
    @Allow(Permission.Owner)
    prepareDescriptionComparison(
        @Ctx() ctx: RequestContext,
        @Args('experimentKey') experimentKey: string,
        @Args('studySessionId') studySessionId?: string,
    ) {
        return this.study.prepare(ctx, experimentKey, studySessionId);
    }

    @Mutation()
    @Allow(Permission.Owner)
    submitDescriptionComparison(
        @Ctx() ctx: RequestContext,
        @Args('input') input: DescriptionComparisonVoteInput,
    ) {
        return this.study.submit(ctx, input);
    }
}

@Resolver()
export class DescriptionStudyAdminResolver {
    constructor(private study: DescriptionStudyService) {}

    @Query()
    @Allow(Permission.SuperAdmin)
    descriptionExperimentStats(@Ctx() ctx: RequestContext, @Args('experimentKey') experimentKey: string) {
        return this.study.stats(ctx, experimentKey);
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    descriptionExperimentResponses(
        @Ctx() ctx: RequestContext,
        @Args('experimentKey') experimentKey: string,
        @Args('skip') skip: number,
        @Args('take') take: number,
    ) {
        return this.study.responses(ctx, experimentKey, skip, take);
    }
}

const sharedTypes = gql`
    enum DescriptionComparisonChoice {
        LEFT
        RIGHT
        EQUAL
        SKIP
    }

    enum DescriptionComparisonVersion {
        OLD
        NEW
    }

    enum DescriptionComparisonSelectedVersion {
        OLD
        NEW
        EQUAL
        SKIP
    }

    enum DescriptionSourceKind {
        VENDOR
        CATALOG
    }

    type DescriptionCharacteristic {
        name: String!
        value: String!
    }
`;

const shopSchema = gql`
    ${sharedTypes}

    enum DescriptionComparisonStatus {
        READY
        COMPLETE
        UNAVAILABLE
    }

    type DescriptionComparison {
        status: DescriptionComparisonStatus!
        ballotToken: String
        studySessionId: String
        productId: String
        slug: String
        productName: String
        imageUrl: String
        sourceUrl: String
        sourceKind: DescriptionSourceKind
        parsedCharacteristics: [DescriptionCharacteristic!]!
        leftText: String
        rightText: String
        completed: Int!
        total: Int!
    }

    input DescriptionComparisonVoteInput {
        ballotToken: String!
        studySessionId: String
        choice: DescriptionComparisonChoice!
        leftComment: String! = ""
        rightComment: String! = ""
    }

    type DescriptionComparisonVoteResult {
        saved: Boolean!
        duplicate: Boolean!
        completed: Int!
    }

    extend type Mutation {
        prepareDescriptionComparison(experimentKey: String!, studySessionId: String): DescriptionComparison!
        submitDescriptionComparison(input: DescriptionComparisonVoteInput!): DescriptionComparisonVoteResult!
    }
`;

const adminSchema = gql`
    ${sharedTypes}

    type DescriptionExperimentProductStats {
        productId: String!
        slug: String!
        productName: String!
        oldVersionId: String!
        newVersionId: String!
        oldHash: String!
        newHash: String!
        oldEmpty: Boolean!
        submitted: Int!
        oldWins: Int!
        newWins: Int!
        equal: Int!
        skipped: Int!
    }

    type DescriptionExperimentStats {
        experimentKey: String!
        totalCandidates: Int!
        assigned: Int!
        submitted: Int!
        participants: Int!
        oldWins: Int!
        newWins: Int!
        equal: Int!
        skipped: Int!
        leftWins: Int!
        rightWins: Int!
        newOnLeft: Int!
        newOnRight: Int!
        products: [DescriptionExperimentProductStats!]!
    }

    type DescriptionExperimentResponse {
        responseId: ID!
        participantKey: String!
        studySessionId: String
        productId: String!
        slug: String!
        productName: String!
        oldVersionId: String!
        newVersionId: String!
        oldHash: String!
        newHash: String!
        leftVersion: DescriptionComparisonVersion!
        rightVersion: DescriptionComparisonVersion!
        choice: DescriptionComparisonChoice!
        selectedVersion: DescriptionComparisonSelectedVersion!
        leftComment: String!
        rightComment: String!
        oldComment: String!
        newComment: String!
        assignedAt: DateTime!
        votedAt: DateTime!
    }

    type DescriptionExperimentResponseList {
        totalItems: Int!
        items: [DescriptionExperimentResponse!]!
    }

    extend type Query {
        descriptionExperimentStats(experimentKey: String!): DescriptionExperimentStats!
        descriptionExperimentResponses(
            experimentKey: String!
            skip: Int! = 0
            take: Int! = 100
        ): DescriptionExperimentResponseList!
    }
`;

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [DescriptionStudyCandidate, DescriptionStudyBallot, DescriptionStudyParticipant],
    providers: [DescriptionStudyService],
    shopApiExtensions: { schema: shopSchema, resolvers: [DescriptionStudyShopResolver] },
    adminApiExtensions: { schema: adminSchema, resolvers: [DescriptionStudyAdminResolver] },
})
export class DescriptionStudyPlugin {}
