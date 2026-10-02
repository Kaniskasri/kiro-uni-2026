# CLOIS — Frontend Conventions

## Component Architecture

- One file per component. Component files are PascalCase (`EventDetailPage.tsx`).
- Co-locate component-specific hooks, types, and helpers in the same directory.
- Shared/reusable components go in `frontend/src/components/`.
- Page-level components go in `frontend/src/pages/`.
- Domain-specific panels (e.g., `AIDescriptionPanel`, `SmartSchedulingPanel`) are co-located with their parent page.

## Routing

Follow the route tree defined in the design exactly:

- Public routes: `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/accept-invite/:token`
- Protected org shell: `/orgs/:orgSlug/*` — all org-scoped pages nest under `OrgShell`
- Profile routes: `/profile`, `/profile/data-export`

Use React Router v6 data router (`createBrowserRouter`). Prefer `loader` functions over `useEffect` for initial data fetching.

## State Management Rules

- **AuthStore (Zustand)**: Holds `{ user, tokens, refreshToken, isAuthenticated }`. Persisted to `localStorage`. Refreshes tokens via Cognito SDK on expiry before any API call.
- **OrgStore (Zustand)**: Holds `{ currentOrg, role, permissions }`. Set on org shell entry, cleared on org switch.
- **Server state (TanStack Query)**: All API data. Query keys must be scoped by `orgId` (e.g., `['events', orgId]`). Never put server data in Zustand.
- **WebSocket events**: Incoming messages call `queryClient.invalidateQueries()` for the relevant key — they do not set state directly.

## Forms

- All forms use React Hook Form with Zod schemas.
- Zod schemas must mirror server-side validation rules exactly (same field constraints, same formats).
- Display field-level validation errors inline. Never use `alert()`.
- Show a 409 conflict error as an inline form message, not a toast.

## API Communication

- All API calls go through a typed `apiClient` wrapper that:
  - Attaches the `Authorization: Bearer <accessToken>` header automatically.
  - Silently refreshes the token via Cognito on 401 and retries once.
  - Includes the `X-Correlation-ID` header for tracing.
- Never call `fetch()` directly in components. Use TanStack Query hooks.

## Real-Time (WebSocket)

- The `useWebSocket` custom hook manages the connection lifecycle: connect with JWT query param, auto-reconnect with exponential backoff on close.
- WebSocket events are typed. The hook dispatches each event type to the relevant `queryClient.invalidateQueries()` call.
- If the WebSocket is unavailable, the Dashboard falls back to polling at 30-second intervals.

## Accessibility Requirements

Every component must meet WCAG 2.1 Level AA:

- All non-text interactive elements (icon buttons, QR images, charts) must have `aria-label` or `aria-describedby`.
- All forms, modals, dropdowns, and tables must be fully keyboard-navigable.
- Date/time values must render in the Member's configured timezone with an ISO 8601 tooltip.
- Text must scale to 200% without horizontal scrolling at a minimum viewport width of 320px.
- `axe-core` must be integrated into Vitest renders for every page component. Zero critical/serious violations are required.

## Tailwind & Styling

- Use Tailwind utility classes. Do not write custom CSS unless absolutely necessary.
- Use shadcn/ui components for common UI elements (dialogs, dropdowns, tables, buttons).
- Status badges for event lifecycle states (Draft, Published, Open, In_Progress, Completed, Cancelled, Archived) must use consistent colours across all pages.

## Error Display

- Validation errors: inline below each field.
- API errors (4xx): display the `message` field from the error response JSON.
- 500 errors: show a generic "Something went wrong" message with a correlation ID for support.
- Bedrock unavailability: show an inline error in the AI panel; never block the main event form.

## Testing

- Use Vitest + Testing Library.
- Test file naming: `ComponentName.test.tsx`.
- Property-based tests use fast-check; test files in `frontend/src/__tests__/properties/`.
- Run `axe-core` in every page component test.
