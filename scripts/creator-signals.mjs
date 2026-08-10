import { createHash } from 'node:crypto'

const clamp=(value,min=0,max=1)=>Math.min(max,Math.max(min,Number.isFinite(Number(value))?Number(value):min))
export const normalizeEntityText=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
const compact=value=>normalizeEntityText(value).replace(/\s+/g,'')
const clubCodes={arsenal:'ars','aston villa':'avl',bournemouth:'bou',brentford:'bre',brighton:'bha','brighton and hove albion':'bha',burnley:'bur',chelsea:'che','crystal palace':'cry',everton:'eve',fulham:'ful',ipswich:'ips','ipswich town':'ips',leeds:'lee','leeds united':'lee',liverpool:'liv','man city':'mci','manchester city':'mci','man united':'mun','manchester united':'mun',newcastle:'new','newcastle united':'new',sunderland:'sun',spurs:'tot',tottenham:'tot','tottenham hotspur':'tot','west ham':'whu','west ham united':'whu',wolves:'wol',wolverhampton:'wol'}
const clubKeys=value=>{
  const normalized=normalizeEntityText(value)
  return new Set([normalized,clubCodes[normalized]].filter(Boolean))
}

function editDistance(left,right){
  const row=Array.from({length:right.length+1},(_,index)=>index)
  for(let i=1;i<=left.length;i++){
    let previous=row[0];row[0]=i
    for(let j=1;j<=right.length;j++){
      const saved=row[j]
      row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(left[i-1]===right[j-1]?0:1))
      previous=saved
    }
  }
  return row[right.length]
}

function similarity(left,right){
  if(!left||!right)return 0
  if(left===right)return 1
  return clamp(1-editDistance(left,right)/Math.max(left.length,right.length))
}

function nameScore(rawName,playerName){
  const raw=normalizeEntityText(rawName),player=normalizeEntityText(playerName)
  if(!raw||!player)return 0
  if(raw===player)return 1
  const rawTokens=raw.split(' '),playerTokens=player.split(' ')
  const rawLast=rawTokens.at(-1)||raw,playerLast=playerTokens.at(-1)||player
  const tokenBest=Math.max(...rawTokens.flatMap(rawToken=>playerTokens.map(playerToken=>similarity(rawToken,playerToken))))
  const lastBest=similarity(rawLast,playerLast)
  const compactBest=similarity(compact(raw),compact(player))
  return clamp(Math.max(tokenBest*.82,lastBest*.9,compactBest*.92))
}

const hash=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,24)

function youtubeExternalId(url){
  try{
    const parsed=new URL(url)
    if(parsed.hostname.includes('youtu.be'))return parsed.pathname.split('/').filter(Boolean)[0]||''
    return parsed.searchParams.get('v')||''
  }catch{return ''}
}

const allowedCategories=new Set(['ROLE','ROTATION','INJURY','SET_PIECES','PENALTIES','PRESEASON','TACTICS','VALUE','STATS','TRANSFER','OTHER'])
const allowedSentiments=new Set(['POSITIVE','NEGATIVE','MIXED','NEUTRAL'])
const allowedDepthRoles=new Set(['FIRST_CHOICE','ROTATION','BACKUP','OUT'])

export function normalizeCreatorPayload(payload){
  if(!payload||typeof payload!=='object')throw new Error('JSON object payload is required')
  const rawSource=payload.source&&typeof payload.source==='object'?payload.source:{}
  const url=String(rawSource.url||payload.sourceUrl||payload.videoUrl||'').trim()
  const externalId=String(rawSource.externalId||payload.videoId||youtubeExternalId(url)||hash(url||JSON.stringify(payload).slice(0,1000))).trim()
  const platform=String(rawSource.platform||'YOUTUBE').toUpperCase().slice(0,30)
  const source={
    platform,
    externalId:externalId.slice(0,160),
    creator:String(rawSource.creator||payload.creator||'Unknown creator').trim().slice(0,160),
    title:String(rawSource.title||payload.videoTitle||'Untitled source').trim().slice(0,500),
    url:url.slice(0,2000),
    publishedAt:rawSource.publishedAt||payload.publishedAt||null,
  }
  const rawClaims=Array.isArray(payload.claims)?payload.claims:Array.isArray(payload.items)?payload.items:[]
  if(!rawClaims.length)throw new Error('claims array is required')
  const claims=rawClaims.slice(0,100).map((raw,index)=>{
    if(!raw||typeof raw!=='object')return null
    const rawPlayerName=String(raw.rawPlayerName||raw.playerName||'').trim().slice(0,200)
    const summary=String(raw.summary||raw.text||'').replace(/\s+/g,' ').trim().slice(0,2000)
    if(!rawPlayerName||!summary)return null
    const category=allowedCategories.has(String(raw.category||'').toUpperCase())?String(raw.category).toUpperCase():'OTHER'
    const sentiment=allowedSentiments.has(String(raw.sentiment||'').toUpperCase())?String(raw.sentiment).toUpperCase():'NEUTRAL'
    const timestampSeconds=raw.timestampSeconds!==null&&raw.timestampSeconds!==undefined&&Number.isFinite(Number(raw.timestampSeconds))?Math.max(0,Math.round(Number(raw.timestampSeconds))):null
    const depthRole=allowedDepthRoles.has(String(raw.depthRole||'').toUpperCase())?String(raw.depthRole).toUpperCase():null
    const startProbability=typeof raw.startProbability==='number'?clamp(raw.startProbability):null
    const externalClaimId=String(raw.externalClaimId||`${source.platform}:${source.externalId}:${timestampSeconds??index}:${normalizeEntityText(rawPlayerName)}:${category}`).slice(0,300)
    return {
      externalClaimId,rawPlayerName,clubHint:raw.clubHint||raw.club||null,positionHint:raw.positionHint||null,
      priceHint:raw.priceHint!==null&&raw.priceHint!==undefined&&Number.isFinite(Number(raw.priceHint))?Number(raw.priceHint):null,category,sentiment,summary,
      evidenceText:raw.evidenceText?String(raw.evidenceText).replace(/\s+/g,' ').trim().slice(0,2000):null,
      timestampSeconds,timeHorizon:raw.timeHorizon||'UNKNOWN',numericClaims:Array.isArray(raw.numericClaims)?raw.numericClaims.slice(0,20):[],
      relatedMentions:Array.isArray(raw.relatedMentions)?raw.relatedMentions.slice(0,20):[],depthRole,startProbability,
      minutesIfStarting:typeof raw.minutesIfStarting==='number'?clamp(raw.minutesIfStarting,0,90):null,
      substituteProbabilityWhenBenched:typeof raw.substituteProbabilityWhenBenched==='number'?clamp(raw.substituteProbabilityWhenBenched):null,
      minutesIfSubstitute:typeof raw.minutesIfSubstitute==='number'?clamp(raw.minutesIfSubstitute,0,45):null,
      confidence:typeof raw.confidence==='number'?clamp(raw.confidence):null,
    }
  }).filter(Boolean)
  if(!claims.length)throw new Error('No valid claims were supplied')
  return {schemaVersion:Number(payload.schemaVersion)||1,source,claims}
}

export function matchCreatorClaim(claim,catalog,aliases=[]){
  const normalizedAlias=normalizeEntityText(claim.rawPlayerName)
  const alias=aliases.find(row=>normalizeEntityText(row.alias)===normalizedAlias)
  if(alias){
    const player=catalog.find(candidate=>Number(candidate.id)===Number(alias.playerId))
    if(player)return {status:'MATCHED',player,confidence:1,candidates:[{player,confidence:1,reasons:['verified alias']}]}
  }
  const clubHint=normalizeEntityText(claim.clubHint),clubHintKeys=clubKeys(claim.clubHint),positionHint=String(claim.positionHint||'').toUpperCase()
  const priceHint=Number(claim.priceHint)
  const candidates=catalog.map(player=>{
    const base=nameScore(claim.rawPlayerName,player.name)
    const clubMatches=clubHint&&[player.club,player.clubName,player.teamName].some(value=>[...clubKeys(value)].some(key=>clubHintKeys.has(key)))
    const positionMatches=positionHint&&String(player.position||'').toUpperCase()===positionHint
    const priceMatches=Number.isFinite(priceHint)&&Math.abs(Number(player.price)-priceHint)<=.1
    const confidence=clamp(base+(clubMatches?.18:0)+(positionMatches?.06:0)+(priceMatches?.05:0))
    const reasons=[`name ${Math.round(base*100)}%`]
    if(clubMatches)reasons.push('club matched')
    if(positionMatches)reasons.push('position matched')
    if(priceMatches)reasons.push('price matched')
    return {player,confidence,reasons}
  }).filter(candidate=>candidate.confidence>=.42).sort((a,b)=>b.confidence-a.confidence||String(a.player.name).localeCompare(String(b.player.name))).slice(0,5)
  const best=candidates[0],runnerUp=candidates[1]
  const margin=!runnerUp?1:best.confidence-runnerUp.confidence
  const strongContext=best?.reasons.includes('club matched')&&best.confidence>=.65&&margin>=.12
  if(best&&(strongContext||(best.confidence>=.72&&margin>=(clubHint?.1:.15))))return {status:'MATCHED',player:best.player,confidence:best.confidence,candidates}
  if(best&&best.confidence>=.5)return {status:'AMBIGUOUS',player:null,confidence:best.confidence,candidates}
  return {status:'UNRESOLVED',player:null,confidence:best?.confidence||0,candidates}
}

export function signalDraftFromClaim(claim,playerId,source,defaultConfidence=.65){
  const value={note:claim.summary}
  for(const key of ['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole']){
    if(claim[key]!==null&&claim[key]!==undefined)value[key]=claim[key]
  }
  const categoryKinds={ROLE:'EXPECTED_ROLE',ROTATION:'DEPTH_CHART',INJURY:'INJURY',SET_PIECES:'SET_PIECES',PENALTIES:'PENALTIES',PRESEASON:'PRESEASON_MINUTES',TACTICS:'TACTICAL_ROLE',VALUE:'VALUE_OPINION',STATS:'STATISTICAL_CLAIM',TRANSFER:'TRANSFER_OPINION',OTHER:'EXPECTED_ROLE'}
  const timestampUrl=source.url&&claim.timestampSeconds!==null
    ? `${source.url}${source.url.includes('?')?'&':'?'}t=${claim.timestampSeconds}s`
    : source.url||null
  return {
    playerId,kind:categoryKinds[claim.category]||'EXPECTED_ROLE',value,sourceType:'YOUTUBE_TRANSCRIPT',sourceUrl:timestampUrl,
    evidenceSummary:claim.summary,confidence:claim.confidence??defaultConfidence,
  }
}
