# Repository Guidelines

## Repository Identity
- Name: ai-chat-session-api
- Type: Backend API
- Framework: NestJS
- Language: TypeScript
- Package Manager: npm

## Project Structure & Module Organization
This is a NestJS backend API. All application code lives in `src/` with the following folder layout:

```
src/
  adapters/       — external service adapters (e.g., third-party API clients)
  auth/           — authentication strategies, JWT handling
  config/         — NestJS configuration modules and environment setup
  controllers/    — route controllers (HTTP entry points)
  decorators/     — custom NestJS decorators
  entities/       — database entity definitions and schemas
  filters/        — NestJS exception filters
  gateways/       — WebSocket or event gateways
  guards/         — NestJS route guards
  mapper/         — data mapping/transformation functions
  middleware/     — NestJS middleware (e.g., request logging)
  pipes/          — NestJS validation and transformation pipes
  providers/      — NestJS providers and injectable services
  services/       — business logic services
  types/          — ALL TypeScript interfaces, types, DTOs, enums
  utils/          — pure utility functions
  validation/     — Zod schemas and validation utilities
```

Not all folders exist yet — create them as needed following this convention.

## Architectural Principles
- **Controllers are thin.** Controllers handle request/response only — extract params, call the service, return the result. No business logic.
- **Services own business logic.** All database operations, external API calls, and data transformations happen in services.
- **Mappers are pure transformations.** Convert database records to DTOs. No service calls, no DB queries, no side effects.
- **Pipes handle validation only.** Run schemas and transform input payloads. No business logic or DB calls.
- **Validation schemas live in `src/validation/`.** Zod schemas go here, not in pipes or services.
- **`src/types/` is the single home for all types and interfaces.** Never define types inline in services, controllers, pipes, or utils.

## File Naming Conventions
- Controllers: `<domain>.controller.ts`
- Services: `<domain>.service.ts`
- Modules: `<domain>.module.ts`
- Guards: `<purpose>.guard.ts`
- Pipes: `<domain>Validation.pipe.ts`
- Mappers: `<domain>.ts` in `src/mapper/`
- Types: `<Domain>.ts` (PascalCase) in `src/types/`
- Validation: `<domain>.schema.ts` or `validate<Thing>.ts`
- Utils: grouped by concern in subfolders (e.g., `utils/s3/`, `utils/transform/`)
- Specs: `<filename>.spec.ts` colocated with the source file

## Build, Test, and Development Commands
- `npm run start:dev`: start local dev server with hot reload
- `npm run build`: production build
- `npm run start:prod`: serve the built app
- `npm test`: run Jest unit tests
- `npm run test:e2e`: run end-to-end tests

## Coding Style & Conventions
- Language: TypeScript (strict mode)
- Formatting: Prettier (`.prettierrc`) and ESLint (`eslint.config.mjs`) are enforced
- Full coding style rules are in `.claude/instructions/style-enforcer.md`

## Commit & Pull Request Guidelines
- Use Conventional Commits (e.g., `feat(chat):`, `fix(auth):`, `chore(config):`)
- PRs should include a short description, testing notes, and affected modules

## Parallel Worktrees
Claude Code manages git worktrees natively. When running parallel agents, each agent works in its own isolated worktree on its own branch. Always create a feature branch for PRs. Run `npm install` in any new worktree before running scripts or tests.
