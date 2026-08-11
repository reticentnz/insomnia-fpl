import type { Position } from '../domain.ts'

/** Official FPL 2026/27 scoring rules. No forecasts or source assumptions belong here. */
export const scoringRules = {
  appearance: { played: 1, sixtyMinutes: 1 },
  goal: { GK: 10, DEF: 6, MID: 5, FWD: 4 },
  assist: 3,
  cleanSheet: { GK: 4, DEF: 4, MID: 1, FWD: 0 },
  goalsConcededPerTwo: { GK: -1, DEF: -1, MID: 0, FWD: 0 },
  savesPerThree: 1,
  penaltySave: 5,
  penaltyMiss: -2,
  ownGoal: -2,
  yellowCard: -1,
  redCard: -3,
  defensiveContribution: 2,
} as const

export type MatchScoreInput = {
  position: Position; minutes: number; goals?: number; assists?: number; cleanSheet?: boolean
  goalsConceded?: number; saves?: number; penaltiesSaved?: number; penaltiesMissed?: number
  ownGoals?: number; yellowCards?: number; redCards?: number; bonus?: number
  clearancesBlocksInterceptions?: number; tackles?: number; recoveries?: number
}

export type MatchScoreBreakdown = {
  appearance: number; goals: number; assists: number; cleanSheet: number; goalsConceded: number
  saves: number; penalties: number; ownGoals: number; cards: number; defensiveContribution: number
  bonus: number; total: number
}

export function allocateBonusPoints(entries: Array<{ playerId: number; bps: number }>): Record<number, number> {
  const sorted = [...entries].sort((a, b) => b.bps - a.bps)
  const unique = [...new Set(sorted.map(row => row.bps))]
  const result: Record<number, number> = {}
  if (!unique.length) return result
  const first = sorted.filter(row => row.bps === unique[0])
  first.forEach(row => { result[row.playerId] = 3 })
  if (first.length === 1) {
    const second = sorted.filter(row => row.bps === unique[1])
    second.forEach(row => { result[row.playerId] = 2 })
    if (second.length === 1) sorted.filter(row => row.bps === unique[2]).forEach(row => { result[row.playerId] = 1 })
  } else if (first.length === 2) {
    sorted.filter(row => row.bps === unique[1]).forEach(row => { result[row.playerId] = 1 })
  }
  return result
}

export function scorePlayerMatch(input: MatchScoreInput): MatchScoreBreakdown {
  const appearance = input.minutes <= 0 ? 0 : input.minutes < 60 ? 1 : 2
  const goals = (input.goals || 0) * scoringRules.goal[input.position]
  const assists = (input.assists || 0) * scoringRules.assist
  const cleanSheet = input.cleanSheet && input.minutes >= 60 ? scoringRules.cleanSheet[input.position] : 0
  const goalsConceded = input.position === 'GK' || input.position === 'DEF' ? Math.floor((input.goalsConceded || 0) / 2) * -1 : 0
  const saves = input.position === 'GK' ? Math.floor((input.saves || 0) / 3) : 0
  const penalties = (input.penaltiesSaved || 0) * scoringRules.penaltySave + (input.penaltiesMissed || 0) * scoringRules.penaltyMiss
  const ownGoals = (input.ownGoals || 0) * scoringRules.ownGoal
  const cards = (input.yellowCards || 0) * scoringRules.yellowCard + (input.redCards || 0) * scoringRules.redCard
  const actions = (input.clearancesBlocksInterceptions || 0) + (input.tackles || 0) + ((input.position === 'MID' || input.position === 'FWD') ? (input.recoveries || 0) : 0)
  const threshold = input.position === 'DEF' ? 10 : 12
  const defensiveContribution = input.position === 'GK' || actions < threshold ? 0 : scoringRules.defensiveContribution
  const bonus = Math.min(3, Math.max(0, input.bonus || 0))
  const total = appearance + goals + assists + cleanSheet + goalsConceded + saves + penalties + ownGoals + cards + defensiveContribution + bonus
  return { appearance, goals, assists, cleanSheet, goalsConceded, saves, penalties, ownGoals, cards, defensiveContribution, bonus, total }
}
