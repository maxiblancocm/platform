import { Injectable } from '@nestjs/common'
import { Filter } from '@ptc-org/nestjs-query-core'
import { Authorizer } from '@ptc-org/nestjs-query-graphql'
import { GqlContext } from '../../auth/typings/gql-context'
import { User } from '../entities/user'

@Injectable()
export class UserAuthorizer implements Authorizer<User> {
  async authorize(context: GqlContext): Promise<Filter<any>> {
    // The auth filter query uses "and" to avoid incorrectly merging the id from the query with the auth id
    return { and: [{ id: { eq: context.req.user.id.toString() } }] }
  }

  authorizeRelation(relationName: string, context: GqlContext): Promise<Filter<unknown>> {
    return Promise.resolve({})
  }
}
