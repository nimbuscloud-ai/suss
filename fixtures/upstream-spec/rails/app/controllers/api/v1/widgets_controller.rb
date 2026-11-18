module Api
  module V1
    class WidgetsController < ApplicationController
      def index
        render json: [{ id: "w1", name: "Spanner" }], status: :ok
      end

      def show
        if params[:id].blank?
          render json: { error: "id is required" }, status: :not_found
        else
          render json: { id: params[:id], name: "Spanner" }, status: :ok
        end
      end
    end
  end
end
