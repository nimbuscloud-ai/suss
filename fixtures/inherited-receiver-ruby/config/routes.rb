Rails.application.routes.draw do
  post "/invoices", to: "invoices#create"
  post "/invoices/logged", to: "invoices#create_logged"
  post "/invoices/built", to: "invoices#create_built"
  post "/invoices/later", to: "invoices#create_later"
  post "/invoices/:id/void", to: "invoices#void"
  post "/invoices/:id/retry_void", to: "invoices#retry_void"
end
