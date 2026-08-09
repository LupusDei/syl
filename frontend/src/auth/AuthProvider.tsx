import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { defaultStorage, type StorageLike } from "../storage";
import { clearApiKey, readApiKey, writeApiKey } from "./api-key-store";

export interface AuthContextValue {
  /** The key currently in effect, or `null` when the operator is signed out. */
  readonly apiKey: string | null;
  readonly isAuthenticated: boolean;
  /** Store a key and authenticate. Blank input is ignored. */
  signIn(key: string): void;
  /** Forget the key. Always available from the chrome. */
  signOut(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  storage?: StorageLike | undefined;
}

export function AuthProvider({ children, storage }: AuthProviderProps): ReactElement {
  const store = useMemo(() => storage ?? defaultStorage(), [storage]);
  const [apiKey, setApiKey] = useState<string | null>(() => readApiKey(store));

  const signIn = useCallback(
    (key: string): void => {
      const trimmed = key.trim();
      // The gate already disables its button for blank input; this is the
      // second line, so no caller can put the app in a "signed in with
      // nothing" state.
      if (trimmed.length === 0) return;
      writeApiKey(store, trimmed);
      setApiKey(trimmed);
    },
    [store],
  );

  const signOut = useCallback((): void => {
    clearApiKey(store);
    setApiKey(null);
  }, [store]);

  const value = useMemo<AuthContextValue>(
    () => ({ apiKey, isAuthenticated: apiKey !== null, signIn, signOut }),
    [apiKey, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth() must be called inside an <AuthProvider>.");
  }
  return value;
}
