import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MUNICIPAL_LAYER, WATER_LAYER,
  parseSearchRegionResults,parseFindRegionResults,
  searchRegions,getRegionGeometry,normalizeGeometry,
  getAdjacentLakeGeometry, mergeGeometries, geometriesTouchOrOverlap, geometryArea
} from '../regions.mjs';

const response=data=>({ok:true,status:200,json:async()=>data});
const originalFetch=globalThis.fetch;
function fakeFetch(handler){globalThis.fetch=async (url)=>handler(new URL(url));}
function restore(){globalThis.fetch=originalFetch;}
const searchSample={results:[{
  id:1777,attrs:{origin:'gg25',featureId:'258-2026',label:'<b>Wädenswil (ZH)</b>'}
}]};

test('Wädenswil: gültige API-Gemeinde ohne optionales layerBodId wird gefunden',()=>{
  assert.deepEqual(parseSearchRegionResults(searchSample),[{id:'258-2026',name:'Wädenswil (ZH)',origin:'gg25'}]);
});
test('Suche ignoriert fremde origins oder layer und interne SearchServer IDs',()=>{
  const data={results:[
    {id:5,attrs:{origin:'zipcode',featureId:'55',label:'Wädenswil 8820'}},
    {id:9,attrs:{origin:'gg25',label:'Wädenswil'}},
    {id:10,attrs:{origin:'gg25',layerBodId:'fremd',featureId:'9',label:'Wädenswil'}},
    {id:11,attrs:{origin:'gg25',layerBodId:MUNICIPAL_LAYER,featureId:'99',label:'Wädenswil'}}
  ]};
  assert.deepEqual(parseSearchRegionResults(data),[{id:'99',name:'Wädenswil',origin:'gg25'}]);
});
test('Fallback map/find: Wädenswil nur aktuell, nie historische Grenzversion',()=>{
 const data={results:[
   {featureId:'4711-1850',layerBodId:MUNICIPAL_LAYER,attributes:{gemname:'Wädenswil',jahr:1850,is_current_jahr:false}},
   {featureId:'4711-2026',layerBodId:MUNICIPAL_LAYER,attributes:{gemname:'Wädenswil',jahr:2026,is_current_jahr:true,objektart_lookup:'politische_gemeinde'}}
 ]};
 assert.deepEqual(parseFindRegionResults(data,'gemeinde','Wädenswil'),[{id:'4711-2026',name:'Wädenswil',origin:'gg25'}]);
});
test('Wädenswil: Such-Endpunkt liefert Treffer, keine unnötige Fallback-Abfrage',async()=>{
 let calls=[];
 fakeFetch(u=>{calls.push(u);return response(searchSample);});
 try{
  const r=await searchRegions('Wädenswil');
  assert.equal(r[0].name,'Wädenswil (ZH)');
  assert.equal(calls.length,1);
  assert.equal(calls[0].searchParams.get('origins'),'gg25');
  assert.equal(calls[0].searchParams.get('searchText'),'Wädenswil');
 }finally{restore();}
});
test('Wädenswil: Ersatzsuche per MapServer/find falls die erste Antwort keine Feature-ID hat',async()=>{
 const calls=[];
 fakeFetch(u=>{
  calls.push(u);
  if(u.pathname.endsWith('SearchServer'))return response({results:[{attrs:{origin:'gg25',label:'Wädenswil'}}]});
  if(u.pathname.endsWith('MapServer/find'))return response({results:[{featureId:'258-2026',attributes:{gemname:'Wädenswil',is_current_jahr:true}}]});
  throw new Error('Unexpected endpoint');
 });
 try{
  const records=await searchRegions('Wädenswil');
  assert.deepEqual(records,[{id:'258-2026',name:'Wädenswil',origin:'gg25'}]);
  assert.equal(calls.length,2);
  assert.equal(calls[1].searchParams.get('searchField'),'gemname');
  assert.equal(calls[1].searchParams.get('layer'),MUNICIPAL_LAYER);
 }finally{restore();}
});
test('Wädenswil: direkter GeoJSON Grenzabruf in LV95',async()=>{
 const polygon={type:'Polygon',coordinates:[[[2693000,1231000],[2693100,1231000],[2693100,1231100],[2693000,1231000]]]};
 fakeFetch(u=>{
  assert.equal(u.searchParams.get('sr'),'2056');
  assert.equal(u.searchParams.get('geometryFormat'),'geojson');
  assert.ok(u.pathname.includes('258-2026'));
  return response({feature:{type:'Feature',geometry:polygon}});
 });
 try{
  const g=await getRegionGeometry('258-2026');
  assert.equal(g.points,4);
  assert.deepEqual(g.bounds,{minE:2693000,minN:1231000,maxE:2693100,maxN:1231100});
 }finally{restore();}
});
test('See-Geometrie wird zur Gemeinde-Maske ergänzt, Fliessgewässer nicht',async()=>{
  const municipality=normalizeGeometry({type:'Polygon',coordinates:[[[2693000,1231000],[2693600,1231000],[2693600,1231600],[2693000,1231600],[2693000,1231000]]]});
  const lake={type:'Polygon',coordinates:[[[2693400,1231200],[2694300,1231200],[2694300,1232100],[2693400,1232100],[2693400,1231200]]]};
  const river={type:'Polygon',coordinates:[[[2690000,1220000],[2690100,1220000],[2690100,1222000],[2690000,1222000],[2690000,1220000]]]};
  fakeFetch(u=>{
    assert.ok(u.pathname.endsWith('MapServer/identify'));
    assert.equal(u.searchParams.get('layers'),`all:${WATER_LAYER}`);
    return response({results:[
      {layerBodId:WATER_LAYER,attributes:{name:'Zürichsee'},geometry:lake},
      {layerBodId:WATER_LAYER,attributes:{name:'Aabach',objektart:'Fliessgewässer'},geometry:river}
    ]});
  });
  try{
    const extra=await getAdjacentLakeGeometry(municipality);
    assert.equal(extra.lakes[0],'Zürichsee');
    assert.ok(extra.geometry);
    assert.ok(geometryArea(extra.geometry)>0);
    const merged=mergeGeometries([municipality,extra.geometry]);
    assert.ok(geometriesTouchOrOverlap(municipality,extra.geometry));
    assert.ok(merged.bounds.maxE>=2694300);
  }finally{restore();}
});
