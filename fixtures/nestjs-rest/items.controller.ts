// fixtures/nestjs-rest/items.controller.ts: a method that runs off the
// end of its body beside one that writes a bare `return;`. Nest sends a
// 200 with an empty body for both, so both read the same way here.
import { Controller, Delete, Param } from "@nestjs/common";

declare const itemService: {
  delete(id: string): Promise<void>;
};

@Controller("items")
export class ItemsController {
  @Delete(":id")
  async remove(@Param("id") id: string) {
    await itemService.delete(id);
  }

  @Delete("archive/:id")
  async archive(@Param("id") id: string) {
    await itemService.delete(id);
    return;
  }
}
