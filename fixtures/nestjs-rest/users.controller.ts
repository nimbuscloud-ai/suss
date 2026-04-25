// fixtures/nestjs-rest/users.controller.ts — exercises class-prefix +
// method-suffix path joining, every common HTTP verb decorator, and
// the param-decorator role mapping.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";

declare const userService: {
  findById(id: string): Promise<User | null>;
  findAll(query: ListQuery): Promise<User[]>;
  create(input: CreateUserInput): Promise<User>;
  update(id: string, input: UpdateUserInput): Promise<User>;
  delete(id: string): Promise<void>;
};

interface User {
  id: string;
  name: string;
}

interface ListQuery {
  page: number;
  pageSize: number;
}

interface CreateUserInput {
  name: string;
  email: string;
}

interface UpdateUserInput {
  name?: string;
}

interface RequestLike {
  user: { id: string };
}

@Controller("users")
export class UsersController {
  @Get()
  async list(@Query() query: ListQuery) {
    return userService.findAll(query);
  }

  @Get(":id")
  async one(@Param("id") id: string) {
    const user = await userService.findById(id);
    if (!user) {
      throw new BadRequestException("user not found");
    }
    return user;
  }

  @Post()
  async create(@Body() input: CreateUserInput, @Headers("authorization") _auth: string) {
    return userService.create(input);
  }

  @Put(":id")
  async update(@Param("id") id: string, @Body() input: UpdateUserInput) {
    return userService.update(id, input);
  }

  @Patch(":id")
  async patch(@Param("id") id: string, @Body() input: UpdateUserInput) {
    return userService.update(id, input);
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Req() _req: RequestLike) {
    await userService.delete(id);
    throw new HttpException("deleted", 204);
  }
}

// Mounted at root — exercises the no-prefix branch.
@Controller()
export class HealthController {
  @Get("ping")
  ping() {
    return { ok: true };
  }
}
