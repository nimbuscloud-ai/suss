// The story's component is declared in the story file itself, and shares
// its name with components elsewhere.
const Preview = ({ heading }: { heading: string }) => <h1>{heading}</h1>;

export default { component: Preview };

export const Full = {
  args: { heading: "Welcome", title: "Unused" },
};
