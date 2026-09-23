---
name: webapp-testing
description: Test or debug web application behavior through the strongest browser, test-runner, accessibility, and inspection capabilities available in the current environment. Use for targeted UI verification, regression checks, responsive behavior, browser console or network failures, screenshots, and end-to-end flows. Do not assume Playwright, Python, a local server, one browser, or permission to mutate real data or contact external services.
license: Complete terms in LICENSE.txt
---

# Web Application Testing

Maintenance notice: substantially rewritten for capability-driven, portable
verification. The original [license and attribution](LICENSE.txt) are retained.

Verify observable web behavior with evidence while minimizing side effects. Adapt
the method to the repository, runtime, operating system, available browser tools,
and risk of the target environment.

## Establish the test contract

Determine from the request and repository:

- behavior or bug to verify,
- acceptance criteria and important failure paths,
- target URL, environment, browser/device support, and authentication state,
- whether the application is static, client-rendered, server-rendered, or composed
  of multiple services,
- data the test may create, modify, or delete,
- external integrations that must be mocked, intercepted, or avoided,
- evidence the user needs: assertions, logs, traces, screenshots, video, or a
  concise manual report.

Ask only for missing information that changes safety or expected behavior. Never
infer permission to use production, send notifications, charge payments, create
real accounts, upload sensitive files, or trigger other external side effects.

## Discover available capabilities

Inspect project instructions, package/build files, existing tests, and available
tools before choosing an approach. Prefer the repository's established framework
and conventions.

Possible capabilities include:

- existing unit, component, integration, or end-to-end tests,
- Playwright, Cypress, WebDriver, Puppeteer, framework-native browser testing, or
  another installed runner,
- an agent/browser interaction tool,
- browser developer-protocol access, console/network logs, traces, or screenshots,
- static inspection of HTML, CSS, templates, and client code,
- manual verification with user-provided observations.

Do not install a new browser or dependency merely because it is familiar. Confirm
before making material dependency or environment changes. If browser automation is
unavailable, use repository-native checks and static inspection, then state which
runtime behavior remains unverified.

## Choose the smallest sufficient test level

### Static inspection

Use for markup, labels, routes, styles, configuration, or obvious rendering logic
that can be verified without executing the application. Static inspection cannot
prove browser behavior, layout, focus order, hydration, or network interactions.

### Component or integration test

Use when a behavior can be isolated with existing test tooling. Prefer this over a
full browser flow when it gives equivalent confidence more quickly and reliably.

### Targeted browser check

Use for one bug, interaction, layout, browser API, or integration boundary. Keep
the flow narrow and collect evidence for the requested behavior.

### Regression test

Reproduce the failure first when practical, make or inspect the fix, then rerun the
same steps plus nearby edge cases. Add a durable automated test when it fits the
repository and protects meaningful behavior.

### End-to-end journey

Use for critical cross-system workflows where browser, server, authentication,
persistence, and integrations must work together. Keep the number of journeys
small; test lower-level permutations below the browser layer.

A broad test suite is not automatically better than a focused check. Match cost
and coverage to the risk.

## Prepare the environment safely

1. Determine whether the required application is already running.
2. Reuse a healthy existing instance when doing so will not disturb user work.
3. Otherwise, start it through documented project commands or the repository's
   normal development environment.
4. Wait for an explicit readiness signal such as a health endpoint, expected DOM
   state, or successful probe—not only an open port or fixed delay.
5. Record the base URL and relevant configuration without exposing secrets.
6. Stop only processes started for this task. Do not kill unrelated processes that
   happen to use the expected port.

For multiple services, respect dependency order and capture startup failures from
each service. Use containerized or repository-provided workflows when required by
project instructions; do not impose them otherwise.

Use an isolated test account, tenant, database, namespace, or fixture set when
available. Prefer synthetic data. Plan cleanup before creating state, and avoid
cleanup that could delete pre-existing user data.

## Explore before acting

For unfamiliar interfaces:

1. Navigate to the intended start state.
2. Wait for an application-specific readiness condition.
3. Inspect visible text, semantic roles, accessible names, URL, and relevant DOM.
4. Capture a baseline screenshot when visual state matters.
5. Review console and failed network activity.
6. Identify stable interaction targets.
7. Execute only the actions needed for the test.

Do not treat `networkidle` as universally reliable: polling, streaming, analytics,
service workers, and long-lived connections may prevent it, while a quiet network
does not prove the UI is ready. Prefer an element, response, navigation, or state
that represents the behavior under test.

## Interact like a user

Prefer selectors in this order when supported:

1. semantic role plus accessible name,
2. associated label or visible user-facing text,
3. explicit stable test identifier,
4. stable application attribute,
5. CSS or DOM position only as a last resort.

Avoid selectors coupled to generated classes, deep DOM structure, array position,
or transient text. Scope selectors when more than one match is legitimate. Treat
ambiguous matches as a test-design problem rather than blindly selecting the first.

Use event-driven waits and assertions instead of arbitrary sleeps. A small delay is
acceptable only when the behavior itself is time-based and no observable event is
available.

## Verify behavior, not merely execution

For each acceptance criterion, define an observable assertion. Depending on the
flow, verify:

- visible result and state transition,
- URL/history behavior,
- persisted state after reload or a new session,
- request method, destination, payload shape, response, and retry behavior,
- disabled/loading/error/empty/success states,
- focus movement, keyboard operation, and accessible name/state,
- console errors and unhandled rejections,
- failed, duplicated, or unexpected network requests,
- authorization and tenant boundaries,
- cancellation, offline, timeout, and partial-failure behavior,
- absence of unintended side effects.

Do not declare success because a click completed or a screenshot looks plausible.
Assert the resulting state.

## Visual and responsive checks

When layout matters, test the agreed viewport matrix rather than one arbitrary
size. Include a narrow mobile viewport, a typical desktop viewport, and specific
breakpoints implicated by the change when relevant.

Check:

- clipping, overflow, overlap, and unintended horizontal scrolling,
- text wrapping and zoom tolerance,
- fixed/sticky elements and virtual keyboards,
- touch target and pointer behavior,
- focus visibility and logical order,
- loading, long-content, empty, and error states,
- light/dark or directionality modes when supported.

Screenshots are evidence, not assertions by themselves. Use visual regression only
when stable baselines, fonts, animation controls, and rendering environment are
managed. Mask or avoid secrets and personal data before capturing artifacts.

## Accessibility checks

Use installed automated accessibility tooling when available, but supplement it
with behavior checks. At minimum, inspect relevant flows for:

- keyboard reachability and operation,
- visible focus,
- semantic controls and headings,
- programmatic labels, names, roles, values, and error associations,
- announcements for dynamic state where required,
- dialog focus containment and restoration,
- contrast and non-color indicators when visual tools support evaluation.

Automated scans do not prove usability or full conformance. Report their scope and
manually checked behavior separately.

## Authentication and external boundaries

Reuse repository-supported authentication fixtures, test identities, storage
state, or local providers. Never ask for or embed personal credentials when a safe
test mechanism exists. Keep saved browser state, cookies, tokens, traces, and
screenshots out of version control unless explicitly intended and sanitized.

Mock or intercept payments, email/SMS, analytics, webhooks, destructive admin
operations, and third-party writes unless the user explicitly authorizes a safe
test environment. Verify the mock boundary itself so a misconfiguration cannot
silently reach the real service.

## Debug systematically

When a test fails, distinguish:

- product defect,
- incorrect test expectation,
- unstable selector or wait,
- environment or startup failure,
- stale authentication/test data,
- browser-specific behavior,
- unavailable external dependency.

Capture the smallest useful diagnostic set: failing step, expected versus observed
state, relevant console/network output, and targeted screenshot or trace. Avoid
collecting full-page content or logs containing secrets when narrower evidence is
enough.

Reproduce before changing code when practical. After a fix, rerun the failing flow
and a focused regression set. Do not hide a product race with longer timeouts or
unbounded retries.

## Preserve useful tests

When adding automation:

- place it with the repository's existing tests,
- use its fixtures, configuration, naming, and cleanup conventions,
- keep setup deterministic and assertions specific,
- isolate test data and make cleanup idempotent,
- avoid ordering dependencies between tests,
- retain traces/screenshots only on failure when supported,
- document environment prerequisites that cannot be encoded.

Do not create one-off Python or JavaScript automation files in the repository when
an interactive browser tool or existing test suite can perform the check without
leaving disposable artifacts.

## Completion report

Report concisely:

- environment, URL scope, browser/viewport, and test method,
- scenarios and acceptance criteria exercised,
- passed and failed observations,
- console, network, accessibility, or responsive findings,
- evidence artifacts and their paths when created,
- data or processes created and cleanup performed,
- behavior not tested and why.

Separate verified observations from inference. Never claim cross-browser,
accessibility, responsive, or end-to-end coverage beyond what was actually run.
