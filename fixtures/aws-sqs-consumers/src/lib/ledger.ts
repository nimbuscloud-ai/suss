// Where every handler puts what it read off a message.

export interface Order {
  id: string;
  total: number;
}

export async function save(...values: unknown[]): Promise<void> {
  void values;
}
