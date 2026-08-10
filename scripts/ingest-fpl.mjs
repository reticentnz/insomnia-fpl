import fs from 'node:fs'
import { getDb } from './db.mjs'
import { MODEL_VERSION, projectPlayer } from '../src/model.ts'

for (const envFile of ['.env.local', '.env']) {
  if (!fs.existsSync(envFile)) continue
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
  }
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

const api = async path => {
  const response = await fetch(`https://fantasy.premierleague.com/api/${path}`)
  if (!response.ok) throw new Error(`FPL API ${path} returned ${response.status}`)
  return response.json()
}
const numeric = value => value === '' || value === null || value === undefined ? 0 : Number(value) || 0
const nullableInt = value => value === null || value === undefined ? null : Number(value)
const positions = { 1:'GK', 2:'DEF', 3:'MID', 4:'FWD' }

console.log('fetching public FPL bootstrap and fixtures…')
const [bootstrap, fixtures] = await Promise.all([api('bootstrap-static/'), api('fixtures/')])
const teamNames=Object.fromEntries(bootstrap.teams.map(team=>[team.id,team.short_name]))
const currentGameweek=bootstrap.events.find(event=>event.is_current)?.id||bootstrap.events.find(event=>event.is_next)?.id||1
const upcomingByTeam=new Map()
for(const fixture of fixtures.filter(row=>row.event&&row.event>=currentGameweek)){
  const home=upcomingByTeam.get(fixture.team_h)||[]
  home.push({gameweek:fixture.event,opponent:teamNames[fixture.team_a]||'OPP',venue:'H',difficulty:numeric(fixture.team_h_difficulty)||3})
  upcomingByTeam.set(fixture.team_h,home)
  const away=upcomingByTeam.get(fixture.team_a)||[]
  away.push({gameweek:fixture.event,opponent:teamNames[fixture.team_h]||'OPP',venue:'A',difficulty:numeric(fixture.team_a_difficulty)||3})
  upcomingByTeam.set(fixture.team_a,away)
}
const matchHistories = []
if (bootstrap.events.some(event => event.finished) && process.env.FPL_INGEST_MATCH_HISTORY !== '0') {
  console.log('fetching match-level player histories…')
  for (let offset = 0; offset < bootstrap.elements.length; offset += 20) {
    const batch = bootstrap.elements.slice(offset, offset + 20)
    const summaries = await Promise.all(batch.map(player => api(`element-summary/${player.id}/`).catch(() => ({history:[]}))))
    summaries.forEach((summary, index) => {
      for (const row of summary.history || []) matchHistories.push({playerId:batch[index].id, ...row})
    })
  }
}

const client = getDb()
const capturedAt = new Date()
try {
  await client.query('BEGIN')
  const season = '2026/27'
  for (const team of bootstrap.teams) {
    await client.query('INSERT INTO "Team" ("id","name","shortName") VALUES ($1,$2,$3) ON CONFLICT ("id") DO UPDATE SET "name"=EXCLUDED."name", "shortName"=EXCLUDED."shortName"', [team.id, team.name, team.short_name])
  }
  for (const event of bootstrap.events) {
    await client.query('INSERT INTO "Gameweek" ("id","season","deadline","finished","isCurrent","isFuture") VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT ("id") DO UPDATE SET "season"=EXCLUDED."season", "deadline"=EXCLUDED."deadline", "finished"=EXCLUDED."finished", "isCurrent"=EXCLUDED."isCurrent", "isFuture"=EXCLUDED."isFuture"', [event.id, season, event.deadline_time || null, Boolean(event.finished), Boolean(event.is_current), Boolean(event.is_next || event.is_current || !event.finished)])
  }
  for (const fixture of fixtures) {
    if (!fixture.event || !fixture.team_h || !fixture.team_a) continue
    await client.query('INSERT INTO "Fixture" ("id","season","gameweekId","homeTeamId","awayTeamId","kickoff","difficultyHome","difficultyAway") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("id") DO UPDATE SET "season"=EXCLUDED."season", "gameweekId"=EXCLUDED."gameweekId", "homeTeamId"=EXCLUDED."homeTeamId", "awayTeamId"=EXCLUDED."awayTeamId", "kickoff"=EXCLUDED."kickoff", "difficultyHome"=EXCLUDED."difficultyHome", "difficultyAway"=EXCLUDED."difficultyAway"', [fixture.id, season, fixture.event, fixture.team_h, fixture.team_a, fixture.kickoff || null, fixture.team_h_difficulty ?? null, fixture.team_a_difficulty ?? null])
  }
  const activeIds = new Set(bootstrap.elements.map(p => p.id))
  const playerColumns = ['id','name','clubId','position','price','status','active','season','chanceOfPlaying','minutes','starts','totalPoints','pointsPerGame','form','epNext','goals','assists','cleanSheets','goalsConceded','saves','bonus','bps','yellowCards','redCards','ownGoals','penaltiesMissed','penaltiesSaved','clearancesBlocksInterceptions','tackles','recoveries','defensiveContribution','defensiveContributionPer90','ownership','transfersIn','transfersOut','expectedGoals','expectedAssists','expectedGI','expectedGC','expectedGoalsPer90','expectedAssistsPer90','expectedGCPer90','savesPer90']
  for (const player of bootstrap.elements) {
    const isActive = player.status !== 'u' && player.status !== 'n'
    const values = [player.id, player.web_name || `${player.first_name} ${player.second_name}`, player.team, positions[player.element_type] || 'MID', numeric(player.now_cost) / 10, player.status || null, isActive, season, nullableInt(player.chance_of_playing_next_round), numeric(player.minutes), numeric(player.starts), numeric(player.total_points), numeric(player.points_per_game), numeric(player.form), numeric(player.ep_next), numeric(player.goals_scored), numeric(player.assists), numeric(player.clean_sheets), numeric(player.goals_conceded), numeric(player.saves), numeric(player.bonus), numeric(player.bps), numeric(player.yellow_cards), numeric(player.red_cards), numeric(player.own_goals), numeric(player.penalties_missed), numeric(player.penalties_saved), numeric(player.clearances_blocks_interceptions), numeric(player.tackles), numeric(player.recoveries), numeric(player.defensive_contribution), numeric(player.defensive_contribution_per_90), numeric(player.selected_by_percent), numeric(player.transfers_in), numeric(player.transfers_out), numeric(player.expected_goals), numeric(player.expected_assists), numeric(player.expected_goal_involvements), numeric(player.expected_goals_conceded), numeric(player.expected_goals_per_90), numeric(player.expected_assists_per_90), numeric(player.expected_goals_conceded_per_90), numeric(player.saves_per_90)]
    const quotedColumns=playerColumns.map(column=>`"${column}"`).join(',')
    const updates=playerColumns.slice(1).map(column=>column==='clubId'
      ? `"previousClubId"=CASE WHEN "Player"."clubId"<>EXCLUDED."clubId" THEN "Player"."clubId" ELSE "Player"."previousClubId" END, "clubChangedAt"=CASE WHEN "Player"."clubId"<>EXCLUDED."clubId" THEN CURRENT_TIMESTAMP ELSE "Player"."clubChangedAt" END, "clubId"=EXCLUDED."clubId"`
      : `"${column}"=EXCLUDED."${column}"`).join(',')
    await client.query(`INSERT INTO "Player" (${quotedColumns}) VALUES (${values.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT ("id") DO UPDATE SET ${updates}, "updatedAt"=CURRENT_TIMESTAMP`, values)
    await client.query('INSERT INTO "PlayerSnapshot" ("playerId","capturedAt","totalPoints","form","minutes","ownership","transfersIn","transfersOut","price") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [player.id, capturedAt, numeric(player.total_points), numeric(player.form), numeric(player.minutes), numeric(player.selected_by_percent), numeric(player.transfers_in), numeric(player.transfers_out), numeric(player.now_cost) / 10])
  }
  const projectionRows=[]
  for(const raw of bootstrap.elements){
    const availability=nullableInt(raw.chance_of_playing_next_round)??(raw.status==='i'||raw.status==='u'?0:raw.status==='d'?75:100)
    const completedGameweeks=Math.max(0,currentGameweek-1)
    const historicalMinutes=numeric(raw.minutes), coldStart=historicalMinutes===0
    const roleMinutes=completedGameweeks?Math.min(90,historicalMinutes/completedGameweeks):coldStart?Math.min(55,Math.max(30,30+numeric(raw.ep_next)*15)):Math.min(90,historicalMinutes/38)
    const expectedMinutes=roleMinutes*availability/100
    const upcomingFixtures=(upcomingByTeam.get(raw.team)||[]).slice(0,5)
    const basePlayer={id:raw.id,name:raw.web_name||`${raw.first_name} ${raw.second_name}`,club:teamNames[raw.team]||'',position:positions[raw.element_type]||'MID',price:numeric(raw.now_cost)/10,form:numeric(raw.form),ownership:numeric(raw.selected_by_percent),minutes:availability,expectedMinutes,coldStart,dataConfidence:coldStart?'LOW':historicalMinutes>=900?'HIGH':'MEDIUM',fixture:upcomingFixtures[0]?`${upcomingFixtures[0].opponent} (${upcomingFixtures[0].venue})`:'Blank',difficulty:upcomingFixtures[0]?.difficulty||3,projection:Math.max(.5,numeric(raw.ep_next)||numeric(raw.points_per_game)*.7+numeric(raw.form)*.3),colour:'#334155',upcomingFixtures,stats:{minutes:historicalMinutes,starts:numeric(raw.starts),totalPoints:numeric(raw.total_points),goals:numeric(raw.goals_scored),assists:numeric(raw.assists),cleanSheets:numeric(raw.clean_sheets),goalsConceded:numeric(raw.goals_conceded),saves:numeric(raw.saves),bonus:numeric(raw.bonus),bps:numeric(raw.bps),yellowCards:numeric(raw.yellow_cards),redCards:numeric(raw.red_cards),ownGoals:numeric(raw.own_goals),penaltiesMissed:numeric(raw.penalties_missed),penaltiesSaved:numeric(raw.penalties_saved),expectedGoals:numeric(raw.expected_goals),expectedAssists:numeric(raw.expected_assists),expectedGoalsConceded:numeric(raw.expected_goals_conceded),expectedGoalsPer90:numeric(raw.expected_goals_per_90),expectedAssistsPer90:numeric(raw.expected_assists_per_90),expectedGoalsConcededPer90:numeric(raw.expected_goals_conceded_per_90),savesPer90:numeric(raw.saves_per_90),clearancesBlocksInterceptions:numeric(raw.clearances_blocks_interceptions),tackles:numeric(raw.tackles),recoveries:numeric(raw.recoveries),defensiveContribution:numeric(raw.defensive_contribution),defensiveContributionPer90:numeric(raw.defensive_contribution_per_90)}}
    for(const fixture of upcomingFixtures){
      const projection=projectPlayer({...basePlayer,upcomingFixtures:[fixture]},fixture.gameweek)
      projectionRows.push([raw.id,fixture.gameweek,MODEL_VERSION,projection.expectedMinutes,projection.expectedGoals,projection.expectedAssists,projection.cleanSheetProbability,projection.expectedBonus,projection.expectedCardDeduction,projection.expectedPoints])
    }
  }
  for(let offset=0;offset<projectionRows.length;offset+=500){
    const rows=projectionRows.slice(offset,offset+500), values=rows.flat()
    const tuples=rows.map((_,rowIndex)=>`(${Array.from({length:10},(_,columnIndex)=>`$${rowIndex*10+columnIndex+1}`).join(',')})`).join(',')
    await client.query('INSERT INTO "PlayerProjection" ("playerId","gameweekId","modelVersion","expectedMinutes","expectedGoals","expectedAssists","cleanSheetProbability","expectedBonus","expectedCardDeduction","expectedPoints") VALUES '+tuples+' ON CONFLICT ("playerId","gameweekId","modelVersion") DO UPDATE SET "expectedMinutes"=EXCLUDED."expectedMinutes","expectedGoals"=EXCLUDED."expectedGoals","expectedAssists"=EXCLUDED."expectedAssists","cleanSheetProbability"=EXCLUDED."cleanSheetProbability","expectedBonus"=EXCLUDED."expectedBonus","expectedCardDeduction"=EXCLUDED."expectedCardDeduction","expectedPoints"=EXCLUDED."expectedPoints"',values)
  }
  for (const row of matchHistories) {
    const values=[row.playerId,numeric(row.fixture),numeric(row.round),numeric(row.opponent_team),Boolean(row.was_home),row.kickoff_time||null,numeric(row.minutes),numeric(row.total_points),numeric(row.goals_scored),numeric(row.assists),numeric(row.clean_sheets),numeric(row.goals_conceded),numeric(row.saves),numeric(row.bonus),numeric(row.bps),numeric(row.yellow_cards),numeric(row.red_cards),numeric(row.own_goals),numeric(row.penalties_missed),numeric(row.penalties_saved),numeric(row.expected_goals),numeric(row.expected_assists),numeric(row.expected_goals_conceded),numeric(row.defensive_contribution),numeric(row.clearances_blocks_interceptions),numeric(row.tackles),numeric(row.recoveries)]
    await client.query('INSERT INTO "PlayerMatchStat" ("playerId","fixtureId","gameweek","opponentTeamId","wasHome","kickoff","minutes","totalPoints","goals","assists","cleanSheets","goalsConceded","saves","bonus","bps","yellowCards","redCards","ownGoals","penaltiesMissed","penaltiesSaved","expectedGoals","expectedAssists","expectedGoalsConceded","defensiveContribution","clearancesBlocksInterceptions","tackles","recoveries") VALUES ('+values.map((_,i)=>`$${i+1}`).join(',')+') ON CONFLICT ("playerId","fixtureId") DO UPDATE SET "gameweek"=EXCLUDED."gameweek","minutes"=EXCLUDED."minutes","totalPoints"=EXCLUDED."totalPoints","goals"=EXCLUDED."goals","assists"=EXCLUDED."assists","cleanSheets"=EXCLUDED."cleanSheets","goalsConceded"=EXCLUDED."goalsConceded","saves"=EXCLUDED."saves","bonus"=EXCLUDED."bonus","bps"=EXCLUDED."bps","yellowCards"=EXCLUDED."yellowCards","redCards"=EXCLUDED."redCards","ownGoals"=EXCLUDED."ownGoals","penaltiesMissed"=EXCLUDED."penaltiesMissed","penaltiesSaved"=EXCLUDED."penaltiesSaved","expectedGoals"=EXCLUDED."expectedGoals","expectedAssists"=EXCLUDED."expectedAssists","expectedGoalsConceded"=EXCLUDED."expectedGoalsConceded","defensiveContribution"=EXCLUDED."defensiveContribution","clearancesBlocksInterceptions"=EXCLUDED."clearancesBlocksInterceptions","tackles"=EXCLUDED."tackles","recoveries"=EXCLUDED."recoveries"',values)
  }
  await client.query('UPDATE "Player" SET "active"=false, "status"=\'u\' WHERE "season"=$1 AND "id" NOT IN (' + Array.from(activeIds).join(',') + ')', [season])
  await client.query('COMMIT')
  const counts = await client.query(`SELECT 'Team' AS table_name, COUNT(*) AS rows FROM "Team" UNION ALL SELECT 'Player', COUNT(*) FROM "Player" UNION ALL SELECT 'Gameweek', COUNT(*) FROM "Gameweek" UNION ALL SELECT 'Fixture', COUNT(*) FROM "Fixture" UNION ALL SELECT 'PlayerSnapshot', COUNT(*) FROM "PlayerSnapshot" UNION ALL SELECT 'PlayerMatchStat', COUNT(*) FROM "PlayerMatchStat" ORDER BY table_name`)
  console.log(`ingestion complete: ${counts.rows.map(row => `${row.table_name}=${row.rows}`).join(', ')}`)
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
