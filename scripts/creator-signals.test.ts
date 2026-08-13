import { describe, expect, it } from 'vitest'
import { expandSqlParams } from './db.mjs'
import { interpretManualSignalText, matchCreatorClaim, normalizeCreatorPayload, signalDraftFromClaim } from './creator-signals.mjs'

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

  it('creates timestamped evidence and only carries explicit role values',()=>{
    const draft=signalDraftFromClaim({category:'VALUE',summary:'Cheap upside',timestampSeconds:69,confidence:.8,startProbability:null,minutesIfStarting:null,substituteProbabilityWhenBenched:null,minutesIfSubstitute:null,depthRole:null},10,{url:'https://www.youtube.com/watch?v=abc123'})
    expect(draft.kind).toBe('VALUE_OPINION')
    expect(draft.value).toEqual({note:'Cheap upside'})
    expect(draft.sourceUrl).toBe('https://www.youtube.com/watch?v=abc123&t=69s')
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
