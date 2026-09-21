import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { evaluateSelection } from '../src/policy.js';
import { classifyNode } from '../src/source/kinds.js';
import { SOURCE_MANIFEST } from '../src/source/manifest.js';
import type { ActualSamples } from '../scripts/full-check.js';
import type { DatasetSummary, RegionSummary } from '../src/types.js';

// Small source-backed fixture only: ordinary unit runs do not read nationwide CSVs or use PostgreSQL.
const samples = JSON.parse(readFileSync(new URL('./fixtures/actual-samples.json',import.meta.url),'utf8')) as ActualSamples;
const dataset:DatasetSummary={...SOURCE_MANIFEST,datasetId:'fixture-only',status:'ready',isActive:true,
  levelCounts:{1:31,2:342,3:2978,4:41352,5:620573},importedAt:'2026-09-17T00:00:00.000Z'};
function path(codes:string[]):RegionSummary[] {
  return codes.map(code=>{
    const source=samples.sourceNodes.find(node=>node.code===code)!;
    const parentCode=source.pathCodes.at(-2)??null;
    const nodeKind=classifyNode(SOURCE_MANIFEST,{...source,parentCode,ancestorCodes:source.pathCodes.slice(0,-1)});
    return {code,sourceName:source.sourceName,label:source.sourceName,level:source.level,parentCode,nodeKind,
      enabled:true,effectiveEnabled:true,navigable:source.level<5,selectable:nodeKind!=='group',hasChildren:source.level<5,
      childrenState:source.level<5?'AVAILABLE':'NONE_IN_SNAPSHOT',sort:0,revision:1};
  });
}
it('pins every actual sample to the five checksummed source files',()=>{
  expect(samples.sourceCommit).toBe(SOURCE_MANIFEST.sourceCommit);
  expect(samples.files).toEqual(SOURCE_MANIFEST.files);
});
it('accepts the ordinary five-level source path with authoritative names',()=>{
  expect(evaluateSelection(dataset,path(samples.ordinary.pathCodes),{pathCodes:samples.ordinary.pathCodes,targetLevel:5}))
    .toMatchObject({accepted:true,reason:'TARGET_REACHED',pathNames:samples.ordinary.pathNames});
});
it('keeps all nine actual groups navigation-only',()=>{
  expect(samples.groups).toHaveLength(9);
  for(const group of samples.groups)expect(evaluateSelection(dataset,path(group.pathCodes),{pathCodes:group.pathCodes,targetLevel:2}))
    .toMatchObject({accepted:false,reason:'NAVIGATION_ONLY'});
});
it('preserves repeated city/county names as separate source levels',()=>{
  for(const pair of samples.sameNamePairs.slice(0,3)) {
    const county=samples.sourceNodes.find(node=>node.code===pair.codes[1])!;
    expect(evaluateSelection(dataset,path(county.pathCodes),{pathCodes:county.pathCodes,targetLevel:3}))
      .toMatchObject({accepted:true,pathNames:expect.arrayContaining([pair.sourceName]),pathCodes:county.pathCodes});
    expect(path(county.pathCodes).slice(-2).map(node=>node.label)).toEqual([pair.sourceName,pair.sourceName]);
  }
});
it('does not classify special-looking names without source evidence',()=>{
  for(const sample of samples.unknownSpecial)expect(path(sample.pathCodes).at(-1)?.nodeKind).toBe('unknown');
});
