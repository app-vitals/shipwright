# Platform / coding decoupling follow-up: Product Specification

**Date**: 2026-10-30
**Sessions**: `platform-coding-decoupling` (app-vitals/agent), `coding-extension-takeover` (app-vitals/shipwright)
**Status**: Approved in planning

## Overview

The agent platform was extracted from Shipwright. Two audits (the specialty-manifest consumers, and a module-by-module platform classification) found that the platform still carries a small set of coding-only code and hardcoded 'coding' defaults, and that the strict specialty manifest system has one real consumer (the coding agent) plus the neutral `specialist` type. This work slims the platform, hands coding-only pieces to Shipwright's coding extension, and simplifies the manifest.

## Goals

- A platform-only install boots and creates a `specialist` agent with no Shipwright files or env.
- Coding-only code lives in Shipwright; the platform keeps only generic code behind the extension seam.
- The coding agent's defaults are plain code in Shipwright, not a YAML manifest.
- The specialty loader shrinks to a minimal `specialist` type record.
- Boundary rules are enforced by a CI gate, not by convention.

## Non-goals

- Moving coding.prisma models or the CODING-OWNED Agent columns (decision recorded in PCD-6.1: stay in the platform schema).
- Changing the specialists repo (it already builds on the platform image; SIL-4.1/4.2 merged).
- Changing live agents' stored `specialty` values or system cron rows.
- worktree-reaper and the 'loop' dispatch kind stay generic for now (not decided as a change).

## Decisions

- Default agent type is `specialist` (not hard-fail); Shipwright sets `coding` explicitly (CET-1.4).
- coding.prisma and the coding Agent columns stay in the platform schema.
- Plan PRs open as usual.

## Constraints

- Add -> migrate -> remove for every moved surface; Shipwright consumes the platform at a pinned version, so each platform removal waits for the Shipwright side to deploy.
- PCD-3.2 (HITL) must confirm live specialty values, pod env and coding agents' plugin rows before PCD-3.3/3.4/5.1.
