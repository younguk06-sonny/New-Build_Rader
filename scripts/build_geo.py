# 사용법: python3 build_geo.py HangJeongDong_verYYYYMMDD.geojson ../public/data/geo.json
# 행정동 경계(vuski/admdongkor)를 시·군·구/시·도 단위로 합치고 단순화합니다. 외부 라이브러리 불필요.
import json,re,collections,math,sys
src=sys.argv[1]; out=sys.argv[2]
g=json.load(open(src))
SHORT={'서울특별시':'서울','부산광역시':'부산','대구광역시':'대구','인천광역시':'인천','대전광역시':'대전','울산광역시':'울산','세종특별자치시':'세종','경기도':'경기','강원특별자치도':'강원','충청북도':'충북','충청남도':'충남','전북특별자치도':'전북','전남광주통합특별시':'전남광주','경상북도':'경북','경상남도':'경남','제주특별자치도':'제주'}
def city(n):
    m=re.match(r'^(.+?시)(.+구)$',n)
    return m.group(1) if m else n
groups=collections.defaultdict(list); sgroups=collections.defaultdict(list)
for f in g['features']:
    p=f['properties']; sd=SHORT[p['sidonm']]; sg=city(p['sggnm'])
    if sd=='세종': sg='세종시'
    geom=f['geometry']; polys=geom['coordinates'] if geom['type']=='MultiPolygon' else [geom['coordinates']]
    rings=[ [tuple(pt) for pt in r] for poly in polys for r in poly]
    groups[(sd,sg)]+=rings; sgroups[sd]+=rings
def dissolve(rings):
    cnt=collections.Counter()
    for r in rings:
        for a,b in zip(r,r[1:]):
            if a==b: continue
            cnt[(a,b) if a<b else (b,a)]+=1
    nxt=collections.defaultdict(list)
    for r in rings:
        for a,b in zip(r,r[1:]):
            if a==b: continue
            if cnt[(a,b) if a<b else (b,a)]==1: nxt[a].append(b)
    out=[]
    while nxt:
        start=next(iter(nxt)); ring=[start]; cur=start
        while True:
            lst=nxt.get(cur)
            if not lst: break
            n=lst.pop()
            if not lst: del nxt[cur]
            ring.append(n); cur=n
            if n==start: break
        if len(ring)>3: out.append(ring)
    return out
def area(r):
    return 0.5*sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(r,r[1:]))
def dp(pts,tol):
    if len(pts)<3: return pts
    keep=[False]*len(pts); keep[0]=keep[-1]=True; st=[(0,len(pts)-1)]
    while st:
        i,j=st.pop(); ax,ay=pts[i]; bx,by=pts[j]; dx,dy=bx-ax,by-ay; L=dx*dx+dy*dy
        md=-1; mk=-1
        for k in range(i+1,j):
            px,py=pts[k]
            if L==0: d=(px-ax)**2+(py-ay)**2
            else:
                t=((px-ax)*dx+(py-ay)*dy)/L; t=max(0,min(1,t)); d=(px-ax-t*dx)**2+(py-ay-t*dy)**2
            if d>md: md=d; mk=k
        if md>tol*tol: keep[mk]=True; st+=[(i,mk),(mk,j)]
    return [p for p,k in zip(pts,keep) if k]
def simplify(rings,tol,minA):
    res=[]
    for r in rings:
        if abs(area(r))<minA: continue
        # split ring at farthest point so DP keeps shape
        s=dp(r,tol)
        if len(s)>=4: res.append([[round(x,4),round(y,4)] for x,y in s])
    return res
stats=[]
feats=[]
for (sd,sg),rings in groups.items():
    d=dissolve(rings); stats.append(len(d))
    s=simplify(d,0.0012,2e-6)
    if not s: s=simplify(d,0.0004,0)
    feats.append({'sd':sd,'n':sg,'r':s})
sfeats=[]
for sd,rings in sgroups.items():
    d=dissolve(rings); s=simplify(d,0.003,2e-5)
    sfeats.append({'sd':sd,'r':s})
json.dump({'sgg':feats,'sido':sfeats},open(out,'w'),ensure_ascii=False,separators=(',',':'))
print(len(feats),len(sfeats),'rings/sgg avg',sum(stats)/len(stats))
print(sorted(f['sd']+' '+f['n'] for f in feats if f['sd'] in('경기','인천')))
