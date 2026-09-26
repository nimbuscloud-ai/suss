/**
 * classMember.ts: how an adapter spells a member that only the class
 * itself has, and none of its instances, such as a Ruby class method or a
 * TypeScript static.
 *
 * Ruby and TypeScript let a class and its instances each have a member of
 * the same name. An adapter records the class's own member under this
 * spelling of the name, and spells a read the same way when the read is
 * off the class itself. A read off an instance keeps the plain name, so
 * each read finds its own member and never the other. The spelling is the
 * one YARD and JSDoc give a class member, `Api.create` beside `Api#create`.
 */

const CLASS_MEMBER_PREFIX = ".";

/** The name a class records its own member `name` under. */
export function classMemberName(name: string): string {
  return `${CLASS_MEMBER_PREFIX}${name}`;
}

/** The member name a class spelling was made from, or null for a plain name. */
export function classMemberOf(name: string): string | null {
  return name.startsWith(CLASS_MEMBER_PREFIX)
    ? name.slice(CLASS_MEMBER_PREFIX.length)
    : null;
}
