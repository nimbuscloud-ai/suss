import type { Interaction, TypeShape } from "@suss/behavioral-ir";

/**
 * The fields an access states: a storage access's columns and key, or
 * the variable a config read takes, which is a field of the runtime's
 * contract. Nothing for any other class.
 */
export function accessDetail(interaction: Interaction): {
  fields: string[];
  by: string[];
  payload?: TypeShape;
} {
  if (interaction.class === "config-read") {
    return {
      fields: interaction.name === null ? [] : [interaction.name],
      by: [],
    };
  }

  if (interaction.class === "stream-write") {
    return interaction.payload === null
      ? { fields: [], by: [] }
      : { fields: [], by: [], payload: interaction.payload };
  }

  if (interaction.class !== "storage-access") {
    return { fields: [], by: [] };
  }
  return {
    fields: interaction.fields,
    by: interaction.selector ?? [],
  };
}
