import { describe, expect, it } from 'vitest'
import { expandSqlParams } from './db.mjs'
import { interpretManualSignalText, matchCreatorClaim, normalizeCreatorPayload, signalDraftFromClaim, shouldAutoApproveCreatorContext } from './creator-signals.mjs'

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

  it('creates timestamped evidence and only carries explicit role values',()=>{
    const draft=signalDraftFromClaim({category:'VALUE',summary:'Cheap upside',timestampSeconds:69,confidence:.8,startProbability:null,minutesIfStarting:null,substituteProbabilityWhenBenched:null,minutesIfSubstitute:null,depthRole:null},10,{url:'https://www.youtube.com/watch?v=abc123'})
    expect(draft.kind).toBe('VALUE_OPINION')
    expect(draft.value).toEqual({note:'Cheap upside'})
    expect(draft.sourceUrl).toBe('https://www.youtube.com/watch?v=abc123&t=69s')
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

  it('creates a context-only structured performance forecast',()=>{
    const payload=normalizeCreatorPayload({source:{url:'https://youtu.be/abc'},claims:[{rawPlayerName:'Groß',category:'PERFORMANCE_FORECAST',summary:'Groß could blank early and drop in price.',forecastMetric:'EXPECTED_POINTS',forecastDirection:'UNDERPERFORM',forecastProbability:.62,forecastHorizon:'GW1'}]})
    expect(payload.claims[0]).toMatchObject({category:'PERFORMANCE_FORECAST',forecastMetric:'EXPECTED_POINTS',forecastDirection:'UNDERPERFORM',forecastProbability:.62,forecastHorizon:'GW1'})
    const draft=signalDraftFromClaim(payload.claims[0],10,payload.source)
    expect(draft).toMatchObject({kind:'PERFORMANCE_FORECAST',claimClass:'PERFORMANCE_FORECAST',modelImpact:'NONE',value:{forecastMetric:'EXPECTED_POINTS',forecastDirection:'UNDERPERFORM',forecastProbability:.62,forecastHorizon:'GW1'}})
    expect(shouldAutoApproveCreatorContext(draft)).toBe(false)
  })

  it('auto-approves safe context while retaining ambiguous or role evidence for review',()=>{
    const opinion=signalDraftFromClaim({category:'VALUE',summary:'Cheap upside'},10,{})
    const selection=signalDraftFromClaim({category:'FPL_SELECTION',summary:'In my team'},10,{})
    const unknown=signalDraftFromClaim({category:'OTHER',summary:'Worth monitoring'},10,{})
    const role=signalDraftFromClaim({category:'ROTATION',summary:'May not start',suggestedInterpretation:{role:'ROTATION_HIGH'}},10,{})
    expect(shouldAutoApproveCreatorContext(opinion)).toBe(true)
    expect(shouldAutoApproveCreatorContext(selection)).toBe(true)
    expect(shouldAutoApproveCreatorContext(unknown)).toBe(false)
    expect(shouldAutoApproveCreatorContext(role)).toBe(false)
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
})
