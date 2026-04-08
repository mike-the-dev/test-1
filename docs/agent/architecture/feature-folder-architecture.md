# Feature Folder Architecture Standard

## Purpose
This document defines the standard feature-folder architecture used in the e-commerce platform application. The goal is consistency, scalability, and clear separation of concerns so features can be built, understood, and maintained independently.

## Top-Level Rule
All user-facing product features live under:

`src/features/`

Each folder under `features/` represents one business feature.

## Feature Folder Structure
Each feature must follow the structure below:

```
src/features/<featureName>/
  _shared/
  list/
  create/
  edit/            (or update/)
  <featureName>.service.ts
  index.ts
```

## Shared Logic Folder (_shared)
The `_shared/` folder contains feature-internal logic that is reused across list/create/edit flows.

Files are grouped by concern using a strict naming convention:

```
_shared/
  <featureName>.types.ts        - TypeScript types, DTOs, form models
  <featureName>.schema.ts       - Zod schemas or validation schemas
  <featureName>.validators.ts  - Custom validation helpers
  <featureName>.mappers.ts     - API <-> UI data transformation
  <featureName>.keys.ts        - TanStack Query keys
  <featureName>.constants.ts   - (optional) feature-specific constants
  <featureName>.helpers.ts     - (optional) pure helper functions
```

Rules:
- `_shared` is not global.
- `_shared` logic may only be used inside its feature.
- Files must always be prefixed with the feature name.

## Action Folders (list / create / edit)
These folders represent user interaction flows.

Each folder contains:
- UI components (presentation only).
- Hooks that encapsulate all logic for that flow.

Example:

```
list/
  <FeatureName>List.tsx
  use<FeatureName>List.ts
  use<FeatureName>Filters.ts        (optional)
  use<FeatureName>Selection.ts      (optional)

create/
  Create<FeatureName>.tsx
  useCreate<FeatureName>.ts
  useCreate<FeatureName>Form.ts

edit/
  Edit<FeatureName>.tsx
  useEdit<FeatureName>.ts
  useEdit<FeatureName>Form.ts
```

## UI vs Logic Rule
UI components must be pure.

UI components:
- Render JSX.
- Map props to views.
- Call handler functions passed from hooks.

UI components must not:
- Call APIs.
- Contain business logic.
- Contain validation rules.
- Use TanStack Query directly.

Hooks own all logic:
- TanStack Query (`useQuery`, `useMutation`).
- Form orchestration.
- Side effects (navigation, toasts).
- Derived/computed state.
- Calling shared validators, mappers, schemas.

## Service File (`<featureName>.service.ts`)
This file defines all API interaction for the feature.

Responsibilities:
- Fetcher functions (GET, POST, PUT, DELETE).
- TanStack Query hooks.
- Cache invalidation.
- Uses `<featureName>.keys.ts` for query keys.

Business logic stays on the backend. Frontend services are transport + caching only.

## index.ts (Public Surface)
Each feature exposes a clean public API via `index.ts`.

Rules:
- Export only page-level or intentionally public components.
- Do not export internal hooks unless explicitly required.
- Avoid deep imports from outside the feature.

## Naming Conventions
- Feature folders: camelCase (e.g., `businessProfile`, `instantService`).
- Components: PascalCase.
- Hooks: usePascalCase.
- Shared files: `<featureName>.<concern>.ts`.
- One feature = one mental model.

## Exceptions (Umbrella / Area Folders)
Brand- or area-named folders (e.g., `instapaytient/`) are not allowed unless they represent an actual app-area shell (layout, navigation, providers).

If used:
- The folder is an area container, not a feature.
- Subfolders must still follow the full feature standard.

Otherwise, features must live directly under `src/features/`.

## Guiding Principle
A feature should be understandable, buildable, testable, and removable in isolation.

If you cannot delete a feature folder without breaking unrelated code, the architecture has been violated.
