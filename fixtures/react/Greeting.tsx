// Component that receives props without destructuring. Exercises the
// non-destructured branch of componentProps: one Input with role
// "props" for the whole params object.

interface GreetingProps {
  name: string;
}

export default function Greeting(props: GreetingProps) {
  return <div>Hello, {props.name}</div>;
}
