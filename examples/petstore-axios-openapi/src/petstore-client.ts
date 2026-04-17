// Petstore consumer code. Each function exercises a different real-world
// pattern that the axios pack + wrapper expansion + OpenAPI stub need to
// handle correctly.

import axios from "axios";

import { getJson } from "./api-client.js";

interface Pet {
  id: number;
  name: string;
  status: string;
}

const api = axios.create({
  baseURL: "https://petstore3.swagger.io/api/v3",
});

// Direct axios.create() instance call with a destructured response and a
// template-literal path. Branches on `status === 404` to model "not found".
// Petstore declares 200 / 400 / 404 — the 400 case is unhandled here and
// suss should surface that.
export async function getPetById(petId: number): Promise<Pet | null> {
  const { data, status } = await api.get(`/pet/${petId}`);
  if (status === 404) {
    return null;
  }
  return data;
}

// Try/catch around axios — axios throws on 4xx/5xx by default, so the
// realistic 404 shape lives in the catch block as `err.response.status`.
export async function safeGetPet(petId: number): Promise<Pet | null> {
  try {
    const { data } = await api.get(`/pet/${petId}`);
    return data;
  } catch (err: any) {
    if (err.response?.status === 404) {
      return null;
    }
    throw err;
  }
}

// Wrapper-call: getJson is in api-client.ts and forwards `path` to axios.
// The wrapper expansion finds this call and synthesises a per-caller
// summary with `GET /pet/findByStatus` so the checker can pair it.
export async function listPets(): Promise<Pet[]> {
  return getJson<Pet[]>("/pet/findByStatus");
}

// Body field reads through the wrapper. The wrapper has already unwrapped
// the response via destructuring, so `pet.id` / `pet.name` / `pet.status`
// are direct body accesses — the synthesised summary's expectedInput
// captures them and the body-compatibility check surfaces optional-field
// findings for `id` and `status` (only `name` and `photoUrls` are required
// on Petstore's Pet schema).
export async function describePetViaWrapper(petId: number): Promise<string> {
  const pet = await getJson<Pet>(`/pet/${petId}`);
  return `${pet.id}: ${pet.name} (${pet.status})`;
}

// Reads body fields after destructuring. `name` is required in Petstore's
// Pet schema; `id` and `status` are optional — suss should emit info-level
// "consumer reads optional field" findings for those two.
export async function describePet(petId: number): Promise<string> {
  const { data } = await api.get(`/pet/${petId}`);
  return `${data.id}: ${data.name} (${data.status})`;
}
