// fixtures/nestjs-graphql/user.resolver.ts — exercises the four
// operation decorators, the class-decorator type argument, the
// `{ name }` override, and the parameter-decorator role mapping.
import {
  Args,
  Context,
  Info,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from "@nestjs/graphql";

declare const userService: {
  findById(id: string): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
};

declare const workspaceService: {
  forUser(userId: string): Promise<Workspace>;
};

interface User {
  id: string;
  name: string;
}

interface Workspace {
  id: string;
  slug: string;
}

interface CreateUserInput {
  name: string;
  email: string;
}

interface GqlContext {
  tenantId: string;
}

@Resolver(() => User)
export class UserResolver {
  @Query(() => User, { nullable: true })
  async findUser(@Args("id") id: string, @Context() _ctx: GqlContext) {
    if (!id) {
      throw new Error("id required");
    }
    return userService.findById(id);
  }

  @Mutation(() => User, { name: "createUserCustom" })
  async createUser(@Args("input") input: CreateUserInput, @Info() _info: unknown) {
    return userService.create(input);
  }

  @ResolveField(() => Workspace)
  async workspace(@Parent() user: User) {
    return workspaceService.forUser(user.id);
  }

  @Subscription(() => User)
  userUpdated() {
    return { id: "stub", name: "stub" };
  }
}

// Top-level operation class — no `@Resolver(() => Type)` argument.
// `@Query` puts its field on the root Query type whatever the class
// says, so the binding is well formed without one.
@Resolver()
export class HealthResolver {
  @Query(() => Boolean)
  ping() {
    return true;
  }
}

// A field resolver with no class type argument, which is the shape
// NestJS rejects at startup. The type this field hangs off is what the
// class argument would have named, so nothing here says it.
@Resolver()
export class UntypedFieldResolver {
  @ResolveField(() => Workspace)
  async homeWorkspace(@Parent() user: User) {
    return workspaceService.forUser(user.id);
  }
}
