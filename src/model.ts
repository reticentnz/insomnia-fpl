/**
 * Legacy public exports. Projection and scoring calculations live in src/core;
 * this module remains only to avoid breaking existing import sites while they
 * are migrated to the calculation boundary.
 */
export {
  MODEL_VERSION,
  horizonProjection,
  playerRoleProfile,
  projectFixture,
  projectPlayer,
  projectionBreakdown,
  selectStrengthMethod,
  fixtureExpectedMinutes,
  fixtureRoleStates,
} from './core/projection.ts'
export { allocateBonusPoints, scorePlayerMatch, scoringRules } from './core/scoring.ts'
export type { Projection, ProjectionBreakdown, FixtureProjection } from './core/projection.ts'
export type { MatchScoreInput, MatchScoreBreakdown } from './core/scoring.ts'
