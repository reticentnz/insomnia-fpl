import { describe, expect, it } from 'vitest'
import { expandSqlParams } from './db.mjs'
import { matchCreatorClaim, normalizeCreatorPayload, signalDraftFromClaim } from './creator-signals.mjs'

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
  it('normalizes legacy n8n items into stable structured claims',()=>{
    const payload=normalizeCreatorPayload({creator:'PL Mate',videoUrl:'https://www.youtube.com/watch?v=abc123',videoTitle:'Hidden gems',items:[{rawPlayerName:'Kai Havt',club:'Arsenal',category:'Rotation',text:'Too risky for GW1',timestampSeconds:122,depthRole:'ROTATION'}]})
    expect(payload.source.externalId).toBe('abc123')
    expect(payload.claims[0].externalClaimId).toBe('YOUTUBE:abc123:122:kai havt:ROTATION')
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
})
