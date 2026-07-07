# Issue #42: Add empty state to dashboard

## User Story
As a first-time user, I want the dashboard to show a helpful empty state so that I know how to import my first transactions.

## Acceptance Criteria

### Scenario: First-time user sees empty state
**Given** a signed-in user has no transactions
**When** they open the dashboard
**Then** they see a friendly empty state
**And** they see an Import Transactions call-to-action

### Scenario: Existing user sees transaction list
**Given** a signed-in user has transactions
**When** they open the dashboard
**Then** they see the transaction list instead of the empty state

## Context
Relevant files likely include `src/app/dashboard/page.tsx`, `src/components/TransactionList.tsx`, and tests under `src/app/dashboard/`.
