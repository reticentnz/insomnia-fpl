import { describe, expect, it } from 'vitest'
import { expandSqlParams } from './db.mjs'
import { finalizeCreatorSignalDraft, interpretManualSignalText, matchCreatorClaim, normalizeCreatorPayload, signalDraftFromClaim, shouldAutoApproveCreatorContext } from './creator-signals.mjs'

const catalog=[
  {id:10,name:'Kai Havertz',club:'ARS',clubName:'Arsenal',position:'FWD',price:8},
  {id:11,name:'Bruno Fernandes',club:'MUN',clubName:'Manchester United',position:'MID',price:9.5},
  {id:12,name:'Álvaro Fernández',club:'TOT',clubName:'Tottenham Hotspur',position:'DEF',price:5},
]

describe('SQLite numbered parameter compatibility',()=>{
  it('duplicates and reorders repeated numbered parameters',()=>{
    expect(expandSqlParams('SELECT $2,$1,$1',[10,20])).toEqual({querySql:'SELECT ?,?,?',params:[20,10,10]})
  })
})

describe('creator signal ingestion helpers',()=>{
  it('normalizes native extraction output into stable structured claims',()=>{
    const payload=normalizeCreatorPayload({source:{platform:'YOUTUBE',externalId:'abc123',creator:'PL Mate',url:'https://www.youtube.com/watch?v=abc123',title:'Hidden gems'},claims:[{rawPlayerName:'Kai Havt',club:'Arsenal',category:'Rotation',text:'Too risky for GW1',timestampSeconds:122,depthRole:'ROTATION'}]})
    expect(payload.source.externalId).toBe('abc123')
    expect(payload.claims[0].externalClaimId).toBe('YOUTUBE:abc123:122:kai havt:ROTATION')
  })

  it('preserves the ingestion source type and converts percentage probabilities safely',()=>{
    const payload=normalizeCreatorPayload({source:{platform:'RSS',signalSourceType:'LLM_RESEARCH',url:'https://example.com/article'},claims:[{rawPlayerName:'Foden',category:'ROLE',summary:'Foden is expected to start.',startProbability:75}]})
    expect(payload.source.signalSourceType).toBe('LLM_RESEARCH')
    expect(payload.claims[0].startProbability).toBe(.75)
    expect(signalDraftFromClaim(payload.claims[0],10,payload.source).sourceType).toBe('LLM_RESEARCH')
  })

  it('does not let a contradictory extracted role override the wording-based interpretation',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[{rawPlayerName:'Foden',category:'ROLE',summary:'Foden has no real competition for the right wing.',depthRole:'OUT',startProbability:0,suggestedInterpretation:{role:'OUT',confidence:.95,rationale:'Unavailable'}}]})
    expect(payload.claims[0].suggestedInterpretation).toMatchObject({role:'FIRST_CHOICE'})
    expect(payload.claims[0]).toMatchObject({depthRole:null,startProbability:null})
    expect(signalDraftFromClaim(payload.claims[0],10,payload.source)).toMatchObject({modelImpact:'ROLE',value:{depthRole:'FIRST_CHOICE',startProbability:.88}})
  })

  it('uses fuzzy club context and uncapped ranking to resolve transcript misspellings',()=>{
    const catalog=[
      {id:1,name:'Sangaré',club:'Brentford',position:'MID',price:5},
      {id:2,name:'Sangaré',club:"Nott'm Forest",position:'MID',price:5},
      {id:3,name:'Thomas',club:'Coventry City',position:'DEF',price:4.5},
      {id:4,name:'Thomas-Asante',club:'Coventry City',position:'FWD',price:5.5},
      {id:5,name:'Mosquera',club:'Arsenal',position:'DEF',price:5.5},
      {id:6,name:'M.Sarr',club:'Chelsea',position:'DEF',price:4.5},
    ]
    expect(matchCreatorClaim({rawPlayerName:'Sangare',clubHint:'Brenford'},catalog).player?.id).toBe(1)
    expect(matchCreatorClaim({rawPlayerName:'Thomas',clubHint:'Coventry',positionHint:'DEF'},catalog).player?.id).toBe(3)
    expect(matchCreatorClaim({rawPlayerName:'Mascara',clubHint:'Arsenal',positionHint:'DEF'},catalog).player?.id).toBe(5)
  })

  it('uses club hints and aliases while preserving ambiguous names for review',()=>{
    const matched=matchCreatorClaim({rawPlayerName:'Kai Havt',clubHint:'Arsenal'},catalog,[])
    expect(matched.status).toBe('MATCHED')
    expect(matched.player?.id).toBe(10)
    const alias=matchCreatorClaim({rawPlayerName:'Jockarez'},catalog,[{alias:'jockarez',playerId:10}])
    expect(alias.player?.id).toBe(10)
    const ambiguous=matchCreatorClaim({rawPlayerName:'Fernandez'},catalog,[])
    expect(ambiguous.status).toBe('AMBIGUOUS')
    const transferAmbiguous=matchCreatorClaim({rawPlayerName:'Nico Williams',category:'TRANSFER',summary:'Arsenal linked with transfer for Nico Williams'},catalog,[])
    expect(transferAmbiguous.status).toBe('DISMISSED')
    expect(transferAmbiguous.reason).toContain('transfer claim for player outside active FPL catalog')
    const spursMatch=matchCreatorClaim({rawPlayerName:'Fernandez',clubHint:'Spurs'},catalog,[])
    expect(spursMatch.player?.id).toBe(12)
  })

  it('matches full legal names and close caption variants only with strong club support',()=>{
    const players=[
      {id:1,name:'Virgil',identityNames:['Virgil van Dijk','van Dijk'],club:'LIV',clubName:'Liverpool',position:'DEF'},
      {id:2,name:'Dubravka',club:'TOT',clubName:'Tottenham Hotspur',position:'GK'},
    ]
    expect(matchCreatorClaim({rawPlayerName:'Van Dijk',clubHint:'Liverpool'},players).player?.id).toBe(1)
    expect(matchCreatorClaim({rawPlayerName:'Bravco',clubHint:'Spurs'},players).player?.id).toBe(2)
    expect(matchCreatorClaim({rawPlayerName:'Johansson',clubHint:'Motherwell'},players)).toMatchObject({status:'DISMISSED',reason:'club is outside the active FPL catalog'})
  })

  it('dismisses historical full names instead of suggesting vaguely similar current players',()=>{
    const players=[
      {id:1,name:'Dubravka',identityNames:['Martin Dubravka'],club:'TOT',clubName:'Tottenham Hotspur',position:'GK'},
      {id:2,name:'Rogers',identityNames:['Morgan Rogers'],club:'CHE',clubName:'Chelsea',position:'MID'},
      {id:3,name:'Colwill',identityNames:['Levi Colwill'],club:'CHE',clubName:'Chelsea',position:'DEF'},
      {id:4,name:'Lewis-Skelly',identityNames:['Myles Lewis-Skelly'],club:'ARS',clubName:'Arsenal',position:'MID'},
      {id:5,name:'Dorgu',identityNames:['Patrick Dorgu'],club:'MUN',clubName:'Manchester United',position:'MID'},
      {id:6,name:'Salah',identityNames:['Mohamed Salah'],club:'LIV',clubName:'Liverpool',position:'MID'},
    ]
    for(const claim of [
      {rawPlayerName:'Martin Skrtel',clubHint:'Liverpool'},
      {rawPlayerName:'Cesc Fabregas',clubHint:'Chelsea'},
      {rawPlayerName:'Gary Cahill',clubHint:'Chelsea'},
      {rawPlayerName:'Laurent Koscielny',clubHint:'Arsenal'},
      {rawPlayerName:'Michael Carrick',clubHint:'Manchester United'},
    ])expect(matchCreatorClaim(claim,players)).toMatchObject({status:'DISMISSED',reason:'full name does not identify a player in the active FPL catalog'})
  })

  it('retains typo-tolerant full-name matching for current players',()=>{
    expect(matchCreatorClaim({rawPlayerName:'Kai Havt',clubHint:'Arsenal'},catalog)).toMatchObject({status:'MATCHED',player:{id:10}})
    expect(matchCreatorClaim({rawPlayerName:'Bruno Fernndes',clubHint:'Manchester United'},catalog)).toMatchObject({status:'MATCHED',player:{id:11}})
  })

  it('creates timestamped evidence and only carries explicit role values',()=>{
    const draft=signalDraftFromClaim({category:'VALUE',summary:'Cheap upside',timestampSeconds:69,confidence:.8,startProbability:null,minutesIfStarting:null,substituteProbabilityWhenBenched:null,minutesIfSubstitute:null,depthRole:null},10,{url:'https://www.youtube.com/watch?v=abc123'})
    expect(draft.kind).toBe('VALUE_OPINION')
    expect(draft.value).toEqual({note:'Cheap upside'})
    expect(draft.sourceUrl).toBe('https://www.youtube.com/watch?v=abc123&t=69s')
  })

  it('strips unsupported role adjustments from transfer and statistical claims',()=>{
    const transfer=signalDraftFromClaim({category:'TRANSFER',summary:'Signed as a star first-choice signing.',depthRole:'FIRST_CHOICE',startProbability:.88},10,{})
    const stats=signalDraftFromClaim({category:'STATS',summary:'Showed defensive talent in a youth tournament.',depthRole:'BACKUP',startProbability:.15},10,{})
    expect(transfer).toMatchObject({modelImpact:'NONE',value:{note:'Signed as a star first-choice signing.'}})
    expect(transfer.value).not.toHaveProperty('depthRole')
    expect(stats).toMatchObject({modelImpact:'NONE',value:{note:'Showed defensive talent in a youth tournament.'}})
    expect(stats.value).not.toHaveProperty('depthRole')
  })

  it('keeps vague injury wording contextual but preserves explicit unavailability',()=>{
    const vague=signalDraftFromClaim({category:'INJURY',summary:'Had a minor issue last season.',depthRole:'OUT',startProbability:0},10,{})
    const explicit=signalDraftFromClaim({category:'INJURY',summary:'Will miss the start of the season.',depthRole:'OUT',startProbability:0},10,{})
    expect(vague).toMatchObject({modelImpact:'NONE',value:{note:'Had a minor issue last season.'}})
    expect(explicit).toMatchObject({modelImpact:'ROLE',value:{depthRole:'OUT',startProbability:0}})
  })

  it('turns an LLM role interpretation into a reviewable calibrated adjustment',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[{rawPlayerName:'Foden',category:'ROTATION',summary:'Cherki may compete for minutes.',suggestedInterpretation:{role:'ROTATION_HIGH',confidence:.72,rationale:'Material competition for attacking midfield minutes.'}}]})
    const draft=signalDraftFromClaim(payload.claims[0],10,payload.source)
    expect(draft).toMatchObject({claimClass:'ROTATION',modelImpact:'ROLE',value:{note:'Cherki may compete for minutes.',depthRole:'ROTATION',startProbability:.4},interpretationConfidence:.72})
    expect(draft.interpretationRationale).toContain('proposed model translation')
  })

  it('supplies a reviewable fallback when clear rotation wording lacks the optional interpretation',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[{rawPlayerName:'Wood',category:'ROTATION',summary:'Wood is 34 and may not get regular starts anymore.'}]})
    expect(payload.claims[0].suggestedInterpretation).toMatchObject({role:'ROTATION_HIGH'})
    expect(signalDraftFromClaim(payload.claims[0],10,payload.source)).toMatchObject({modelImpact:'ROLE',value:{depthRole:'ROTATION',startProbability:.4}})
  })

  it('derives only explicit availability and secure-role translations from creator wording',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[
      {rawPlayerName:'Gomez',category:'INJURY',summary:'Gomez is going to miss the start of the season.'},
      {rawPlayerName:'Nunez',category:'ROLE',summary:'Nunez has no real competition for the right-back spot.'},
      {rawPlayerName:'Isak',category:'INJURY',summary:'Isak has a poor historical injury record.'},
    ]})
    expect(payload.claims.map(claim=>claim.suggestedInterpretation?.role||null)).toEqual(['OUT','FIRST_CHOICE',null])
  })

  it('does not permit a model interpretation for creator FPL selections',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[{rawPlayerName:'Foden',category:'FPL_SELECTION',summary:'I am benching Foden.',suggestedInterpretation:{role:'ROTATION_HIGH',confidence:.9,rationale:'Ignored'}}]})
    expect(payload.claims[0].suggestedInterpretation).toBeNull()
    expect(signalDraftFromClaim(payload.claims[0],10,payload.source)).toMatchObject({modelImpact:'NONE'})
  })

  it('creates a context-only structured performance forecast and auto-approves it',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[{rawPlayerName:'Groß',category:'PERFORMANCE_FORECAST',summary:'Groß could blank early and drop in price.',forecastMetric:'EXPECTED_POINTS',forecastDirection:'UNDERPERFORM',forecastProbability:.62,forecastHorizon:'GW1'}]})
    expect(payload.claims[0]).toMatchObject({category:'PERFORMANCE_FORECAST',forecastMetric:'EXPECTED_POINTS',forecastDirection:'UNDERPERFORM',forecastProbability:.62,forecastHorizon:'GW1'})
    const draft=signalDraftFromClaim(payload.claims[0],10,payload.source)
    expect(draft).toMatchObject({kind:'PERFORMANCE_FORECAST',claimClass:'PERFORMANCE_FORECAST',modelImpact:'NONE',value:{forecastMetric:'EXPECTED_POINTS',forecastDirection:'UNDERPERFORM',forecastProbability:.62,forecastHorizon:'GW1'}})
    expect(shouldAutoApproveCreatorContext(draft)).toBe(true)
  })

  it('automatically finalizes context and high-confidence role evidence without applying uncertain roles',()=>{
    const opinion=signalDraftFromClaim({category:'VALUE',summary:'Cheap upside'},10,{})
    const selection=signalDraftFromClaim({category:'FPL_SELECTION',summary:'In my team'},10,{})
    const unknown=signalDraftFromClaim({category:'OTHER',summary:'Worth monitoring'},10,{})
    const role=signalDraftFromClaim({category:'ROTATION',summary:'May not start',suggestedInterpretation:{role:'ROTATION_HIGH'}},10,{})
    const lowConfRole=signalDraftFromClaim({category:'ROTATION',summary:'May not start',confidence:.3,suggestedInterpretation:{role:'ROTATION_HIGH'}},10,{})
    expect(shouldAutoApproveCreatorContext(opinion)).toBe(true)
    expect(shouldAutoApproveCreatorContext(selection)).toBe(true)
    expect(shouldAutoApproveCreatorContext(unknown)).toBe(true)
    expect(shouldAutoApproveCreatorContext(role)).toBe(true)
    expect(shouldAutoApproveCreatorContext(lowConfRole)).toBe(false)
    expect(finalizeCreatorSignalDraft(unknown)).toMatchObject({status:'VERIFIED',claimClass:'UNKNOWN',modelImpact:'NONE'})
    expect(finalizeCreatorSignalDraft(lowConfRole)).toMatchObject({status:'VERIFIED',claimClass:'VALUE_OPINION',modelImpact:'NONE',value:{note:'May not start'}})
    expect(finalizeCreatorSignalDraft(lowConfRole).value).not.toHaveProperty('startProbability')
  })

  it('derives backup, nailed starter, bench risk, and surgery/sidelined interpretations from wording',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[
      {rawPlayerName:'Trafford',category:'ROLE',summary:'Trafford is the backup keeper and second choice.'},
      {rawPlayerName:'Saka',category:'ROLE',summary:'Saka is nailed on and guaranteed to start.'},
      {rawPlayerName:'Foden',category:'ROTATION',summary:'Foden carries bench risk and could lose his place.'},
      {rawPlayerName:'Rodri',category:'INJURY',summary:'Rodri underwent surgery and is sidelined with a torn ACL.'},
    ]})
    expect(payload.claims.map(claim=>claim.suggestedInterpretation?.role||null)).toEqual(['BACKUP','FIRST_CHOICE','ROTATION_HIGH','OUT'])
    expect(signalDraftFromClaim(payload.claims[0],10,payload.source)).toMatchObject({modelImpact:'ROLE',value:{depthRole:'BACKUP'}})
    expect(signalDraftFromClaim(payload.claims[1],11,payload.source)).toMatchObject({modelImpact:'ROLE',value:{depthRole:'FIRST_CHOICE'}})
    expect(signalDraftFromClaim(payload.claims[2],12,payload.source)).toMatchObject({modelImpact:'ROLE',value:{depthRole:'ROTATION'}})
    expect(signalDraftFromClaim(payload.claims[3],13,payload.source)).toMatchObject({modelImpact:'ROLE',value:{depthRole:'OUT'}})
  })

  it('treats creator bench choices as context and strips accidental role values',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[{rawPlayerName:'Thomas',category:'ROLE',summary:'Included on my GW2 bench for the bench boost.',depthRole:'BACKUP',startProbability:.1}]})
    expect(payload.claims[0]).toMatchObject({category:'FPL_SELECTION',depthRole:null,startProbability:null})
    const draft=signalDraftFromClaim(payload.claims[0],10,payload.source)
    expect(draft).toMatchObject({kind:'VALUE_OPINION',claimClass:'FPL_SELECTION',modelImpact:'NONE'})
  })

  it('extracts only the Woodman role claim and keeps the Kinsky rating contextual',()=>{
    const manual=`Woodman is a problem. Liverpool currently have Alisson, Mamardashvili and Woodman; Woodman is £4.0m precisely because he's not expected to be the regular starter. I wouldn't begin GW1 deliberately without a playing keeper. The Scout currently likes Kinsky £4.5m as the budget GK option.`
    const drafts=interpretManualSignalText(manual,[
      {id:1,name:'Woodman',position:'GK'}, {id:2,name:'Alisson',position:'GK'}, {id:3,name:'Mamardashvili',position:'GK'}, {id:4,name:'Kinsky',position:'GK'}, {id:5,name:'Scott',position:'MID'},
    ])
    expect(drafts.map(draft=>draft.playerId)).toEqual([1,4])
    expect(drafts[0]).toMatchObject({claimClass:'REAL_WORLD_ROLE',modelImpact:'ROLE',value:{depthRole:'BACKUP',startProbability:.08}})
    expect(drafts[1]).toMatchObject({claimClass:'CREATOR_RATING',modelImpact:'NONE'})
  })

  it('does not interpret a negated expected-start statement as first-choice evidence',()=>{
    const drafts=interpretManualSignalText('Saka is not expected to start this week.',[{id:1,name:'Saka',position:'MID'}])
    expect(drafts[0]).toMatchObject({claimClass:'ROTATION',modelImpact:'ROLE',value:{depthRole:'ROTATION'}})
    expect(drafts[0].value.startProbability).not.toBe(.88)
  })
})
