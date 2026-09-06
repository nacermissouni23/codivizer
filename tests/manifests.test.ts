import { describe, it, expect, afterEach } from 'vitest';
import { GraphStore } from '../src/index/store';
import { loadManifests } from '../src/index/manifests';
import { makeTempRepo, rmTemp } from './helpers/tmp';

const dirs: string[] = [];
async function repo(files: any[]): Promise<string> {
  const d = await makeTempRepo(files);
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rmTemp(d);
});

function storeWith(deps: Array<[string, string]>) {
  const s = new GraphStore();
  for (const [n, src] of deps) s.addManifestDep(n, src);
  return s;
}

describe('manifest parsers', () => {
  it('parses package.json deps', async () => {
    const root = await repo([
      { path: 'package.json', content: JSON.stringify({
        dependencies: { lodash: '^4.17.0', '@types/node': '^20' },
        devDependencies: { vitest: '^2.0.0' },
      }) },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['package.json'], store);
    expect(store.manifestDeps.has('lodash')).toBe(true);
    expect(store.manifestDeps.has('vitest')).toBe(true);
    expect(store.manifestDeps.has('@types/node')).toBe(false); // filtered
  });

  it('parses requirements.txt', async () => {
    const root = await repo([
      { path: 'requirements.txt', content: '# comment\nflask>=3.0\n-r other.txt\ndjango==4.2\n' },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['requirements.txt'], store);
    expect(store.manifestDeps.has('flask')).toBe(true);
    expect(store.manifestDeps.has('django')).toBe(true);
  });

  it('parses pyproject.toml with both [project] and [tool.poetry]', async () => {
    const root = await repo([
      { path: 'pyproject.toml', content: `
[project]
name = "x"
dependencies = ["flask>=3", "requests"]

[tool.poetry.dependencies]
python = "^3.10"
sqlalchemy = "^2.0"
` },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['pyproject.toml'], store);
    expect(store.manifestDeps.has('flask')).toBe(true);
    expect(store.manifestDeps.has('requests')).toBe(true);
    expect(store.manifestDeps.has('sqlalchemy')).toBe(true);
    expect(store.manifestDeps.has('python')).toBe(false); // excluded
  });

  it('parses go.mod with block require', async () => {
    const root = await repo([
      { path: 'go.mod', content: `module example.com/foo\ngo 1.22\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgolang.org/x/sys v0.0.0\n)\nrequire golang.org/x/net v1.0.0\n` },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['go.mod'], store);
    expect(store.manifestDeps.has('github.com/gin-gonic/gin')).toBe(true);
    expect(store.manifestDeps.has('golang.org/x/sys')).toBe(true);
    expect(store.manifestDeps.has('golang.org/x/net')).toBe(true);
  });

  it('parses pom.xml with group:artifact (Phase 4 fix)', async () => {
    const root = await repo([
      { path: 'pom.xml', content: `<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>6.0.0</version>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>32.0.0</version>
    </dependency>
  </dependencies>
</project>` },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['pom.xml'], store);
    expect(store.manifestDeps.has('org.springframework:spring-core')).toBe(true);
    expect(store.manifestDeps.has('com.google.guava:guava')).toBe(true);
    // No bare artifactId-only entries (no collision)
    expect(store.manifestDeps.has('spring-core')).toBe(false);
  });

  it('parses Cargo.toml', async () => {
    const root = await repo([
      { path: 'Cargo.toml', content: `[package]\nname = "x"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n\n[dev-dependencies]\nproptest = "1"\n` },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['Cargo.toml'], store);
    expect(store.manifestDeps.has('serde')).toBe(true);
    expect(store.manifestDeps.has('tokio')).toBe(true);
    // Phase 4 enhancement: dev-dependencies also parsed
    expect(store.manifestDeps.has('proptest')).toBe(true);
  });

  it('parses composer.json', async () => {
    const root = await repo([
      { path: 'composer.json', content: JSON.stringify({
        require: { 'php': '^8.0', 'laravel/framework': '^10.0' },
        'require-dev': { 'phpunit/phpunit': '^10.0' },
      }) },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['composer.json'], store);
    expect(store.manifestDeps.has('laravel/framework')).toBe(true);
    expect(store.manifestDeps.has('phpunit/phpunit')).toBe(true);
    expect(store.manifestDeps.has('php')).toBe(false);
  });

  it('parses Gemfile', async () => {
    const root = await repo([
      { path: 'Gemfile', content: `source "https://rubygems.org"\ngem "rails", "~> 7.0"\ngem "puma"\n` },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['Gemfile'], store);
    expect(store.manifestDeps.has('rails')).toBe(true);
    expect(store.manifestDeps.has('puma')).toBe(true);
  });

  it('parses *.csproj', async () => {
    const root = await repo([
      { path: 'App.csproj', content: `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>` },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['App.csproj'], store);
    expect(store.manifestDeps.has('Newtonsoft.Json')).toBe(true);
    expect(store.manifestDeps.has('Serilog')).toBe(true);
  });

  it('parses *.gradle (filtered to dep scope)', async () => {
    const root = await repo([
      { path: 'build.gradle', content: `
plugins { id 'java' }
dependencies {
    implementation 'org.springframework:spring-core:6.0.0'
    testImplementation 'junit:junit:4.13'
    implementation "com.google.guava:guava:32.0.0"
}
` },
    ]);
    const store = new GraphStore();
    loadManifests(root, ['build.gradle'], store);
    expect(store.manifestDeps.has('spring-core')).toBe(true);
    expect(store.manifestDeps.has('junit')).toBe(true);
    expect(store.manifestDeps.has('guava')).toBe(true);
  });
});

describe('GraphStore', () => {
  it('clears state', () => {
    const s = storeWith([['lodash', 'package.json']]);
    s.addSymbol({ id: 'a:1', kind: 'function', name: 'a', fileId: 'a.ts', startLine: 1, endLine: 1, signature: 'a()' });
    s.addEdge('a.ts', 'lodash', 'imports');
    expect(s.nodes.size).toBeGreaterThan(0);
    s.clear();
    expect(s.nodes.size).toBe(0);
    expect(s.edges.length).toBe(0);
  });

  it('deduplicates edges', () => {
    const s = new GraphStore();
    s.addEdge('a.ts', 'b.ts', 'imports');
    s.addEdge('a.ts', 'b.ts', 'imports');
    expect(s.edges.length).toBe(1);
  });

  it('deduplicates calls but not contains', () => {
    const s = new GraphStore();
    s.addSymbol({ id: 'a.ts:s:foo', kind: 'function', name: 'foo', fileId: 'a.ts', startLine: 1, endLine: 1, signature: 'foo()' });
    s.addSymbol({ id: 'a.ts:s:bar', kind: 'function', name: 'bar', fileId: 'a.ts', startLine: 5, endLine: 5, signature: 'bar()' });
    s.addEdge('a.ts:s:foo', 'a.ts:s:bar', 'calls');
    s.addEdge('a.ts:s:foo', 'a.ts:s:bar', 'calls');
    expect(s.edges.filter(e => e.type === 'calls').length).toBe(1);
    s.addEdge('a.ts', 'a.ts:s:foo', 'contains');
    s.addEdge('a.ts', 'a.ts:s:foo', 'contains');
    expect(s.edges.filter(e => e.type === 'contains').length).toBe(2);
  });

  it('searchSymbols returns matching symbols', () => {
    const s = new GraphStore();
    s.addSymbol({ id: 'a.ts:s:foo', kind: 'function', name: 'fooBar', fileId: 'a.ts', startLine: 1, endLine: 1, signature: 'fooBar()' });
    s.addSymbol({ id: 'a.ts:s:baz', kind: 'function', name: 'bazQux', fileId: 'a.ts', startLine: 5, endLine: 5, signature: 'bazQux()' });
    const hits = s.searchSymbols('foo');
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe('fooBar');
  });

  it('stats reports counts', () => {
    const s = new GraphStore();
    s.addFile('a.ts');
    s.addFile('b.ts');
    s.addSymbol({ id: 'a.ts:s:foo', kind: 'function', name: 'foo', fileId: 'a.ts', startLine: 1, endLine: 1, signature: 'foo()' });
    s.addEdge('a.ts', 'b.ts', 'imports');
    s.addEdge('a.ts:s:foo', 'a.ts:s:foo', 'calls'); // self - skipped
    const stats = s.stats();
    expect(stats.files).toBe(2);
    expect(stats.syms).toBe(1);
    expect(stats.imports).toBe(1);
    expect(stats.calls).toBe(0);
  });

  it('manifestDeps aggregates sources', () => {
    const s = new GraphStore();
    s.addManifestDep('lodash', 'package.json');
    s.addManifestDep('lodash', 'pnpm-lock.yaml');
    expect(s.manifestDeps.get('lodash')).toBe('package.json, pnpm-lock.yaml');
  });
});
