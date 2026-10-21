Rails.application.routes.draw do
  post "/events/send/:kind", to: "events#via_send"
  post "/events/literal", to: "events#via_literal_send"
  post "/events/finish/:kind", to: "events#via_finish"
  post "/events/public/:kind", to: "events#via_public_send"
  post "/events/table/:kind", to: "events#via_table"
  post "/events/conditional/:kind", to: "events#via_conditional"
  post "/events/methods/:kind", to: "events#via_method_table"
  post "/events/block", to: "events#via_block"
  post "/events/proc", to: "events#via_proc"
end
