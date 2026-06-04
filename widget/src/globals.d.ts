// Module-federation remote modules provided by the customer-site host at
// runtime. They have no published types, so declare them loosely here.
declare module "customer_site/RemoteComponentWrapper" {
  import type { ReactNode } from "react";
  const RemoteComponentWrapper: (props: { children: ReactNode }) => JSX.Element;
  export default RemoteComponentWrapper;
}

declare module "customer_site/useRemoteParams" {
  export function useRemoteParams(): Record<string, string | undefined>;
}

// google-maps-react-markers ships its own types, but declare loosely to avoid a
// hard type dependency in the federated build.
declare module "google-maps-react-markers" {
  const GoogleMap: (props: Record<string, unknown>) => JSX.Element;
  export default GoogleMap;
}

declare module "*.css";
