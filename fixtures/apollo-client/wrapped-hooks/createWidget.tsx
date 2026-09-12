// A mutation through the project's mutation hook. The operation type
// comes from the document header, and the component reads the result
// the way it would read Apollo's own.

import { gql } from "@apollo/client";

import { useAppMutation } from "./hooks.js";

const CREATE_WIDGET = gql`
  mutation CreateWidget($label: String!) {
    createWidget(label: $label) {
      id
    }
  }
`;

export function CreateWidget() {
  const [create, { error }] = useAppMutation(CREATE_WIDGET);
  if (error !== undefined) {
    return "could not create the widget";
  }
  return create;
}
