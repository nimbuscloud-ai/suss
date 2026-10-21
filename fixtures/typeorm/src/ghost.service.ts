// The entity's module does not exist, so the call is recorded without a
// table.

import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Ghost } from "./entities/ghost";

export class GhostService {
  constructor(@InjectRepository(Ghost) private readonly ghosts: Repository<unknown>) {}

  list() {
    return this.ghosts.find();
  }
}
