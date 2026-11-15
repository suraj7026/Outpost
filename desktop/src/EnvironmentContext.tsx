import { createContext, useContext } from "react";
import type { Connection } from "./useConnection";

export const EnvironmentContext = createContext<Connection | null>(null);
export function useEnvironmentConnection() {
  const connection = useContext(EnvironmentContext);
  if (!connection) throw new Error("An environment owner is required.");
  return connection;
}
