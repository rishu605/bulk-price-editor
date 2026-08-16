/// <reference types="@shopify/app-bridge-types" />

// App Bridge declares `s-app-nav` (and other admin-only elements) as a global JSX
// augmentation. The template picked it up incidentally, because
// app/routes/app._index.tsx happened to import `useAppBridge`. The reference above
// makes it explicit, so removing an import from any single route cannot silently
// break typechecking for the whole app. It must stay at the very top of this file:
// triple-slash directives are ignored once any other statement precedes them.

declare module "*.css";
