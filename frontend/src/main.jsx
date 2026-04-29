import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'
import './index.css'
import { pages, sku } from './data'

const Card = ({children, className=''}) => <div className={`rounded-2xl bg-white border border-slate-200 shadow-sm p-5 ${className}`}>{children}</div>

function Layout({children}) {
  const loc = useLocation()
  return <div className='min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 text-slate-800'>
    <header className='border-b border-slate-200 bg-white/80 backdrop-blur sticky top-0 z-10'>
      <div className='max-w-7xl mx-auto p-4 flex items-center justify-between'>
        <h1 className='font-semibold text-xl'>Living Dessert Lab OS</h1>
        <span className='text-xs px-3 py-1 rounded-full bg-emerald-50 text-labgreen border border-emerald-100'>Stainless Lab Mode</span>
      </div>
    </header>
    <div className='max-w-7xl mx-auto p-4 grid lg:grid-cols-[240px_1fr] gap-4'>
      <aside className='space-y-2'>
        {pages.map(p=>{ const path='/' + p.toLowerCase().replace(/ /g,'-'); const active=loc.pathname===path || (loc.pathname==='/'&&p==='Dashboard'); return <Link key={p} to={p==='Dashboard'?'/':path} className={`block px-4 py-2 rounded-xl border ${active?'bg-slate-800 text-white border-slate-800':'bg-white border-slate-200 hover:border-labgreen'}`}>{p}</Link>})}
      </aside>
      <main>{children}</main>
    </div>
  </div>
}

const Dashboard=()=> <div className='grid md:grid-cols-3 gap-4'>
  <Card className='md:col-span-2'><h2 className='text-lg font-semibold'>Today’s Focus SKU</h2><p className='mt-2 text-slate-600'>{sku.id} — {sku.name}</p><p className='text-sm mt-3'>Robot readiness: <b>{sku.robotReadiness}%</b></p></Card>
  <Card><h3 className='font-medium'>Greenhouse Links</h3><ul className='mt-2 text-sm list-disc ml-5'>{sku.greenhouseLinks.map(g=><li key={g}>{g}</li>)}</ul></Card>
  <Card className='md:col-span-3'><h3 className='font-medium mb-2'>Step Timers</h3><div className='grid sm:grid-cols-2 lg:grid-cols-4 gap-2'>{sku.workflow.map((w,i)=><div key={i} className='p-3 rounded-xl bg-slate-50 border'>{w.timer}s · {w.tool}</div>)}</div></Card>
</div>

const SkuDetail=()=> <div className='space-y-4'>
  <Card><h2 className='text-xl font-semibold'>{sku.id} — {sku.name}</h2><p className='text-slate-600'>{sku.category}</p></Card>
  <div className='grid md:grid-cols-2 gap-4'>
    <Card><h3 className='font-semibold mb-2'>Ingredients</h3>{sku.ingredients.map(i=><p key={i.name} className='text-sm'>{i.name} <span className='text-slate-500'>({i.qty})</span></p>)}</Card>
    <Card><h3 className='font-semibold mb-2'>Tools</h3><ul className='text-sm list-disc ml-5'>{sku.tools.map(t=><li key={t}>{t}</li>)}</ul></Card>
    <Card><h3 className='font-semibold mb-2'>Variant Options</h3><p className='text-sm'>Dairy / Non-dairy: {sku.options.dairy.join(' · ')}</p><p className='text-sm mt-2'>Sugar / Sugar-free: {sku.options.sugar.join(' · ')}</p><p className='text-sm mt-2'>Gluten / Gluten-free: {sku.options.gluten.join(' · ')}</p></Card>
    <Card><h3 className='font-semibold mb-2'>Media Placeholders</h3><div className='grid grid-cols-3 gap-2'>{sku.media.map(m=><div key={m} className='h-20 rounded-lg bg-slate-100 border text-xs flex items-center justify-center'>{m}</div>)}</div></Card>
  </div>
</div>

const OperatorMode=()=>{const [idx,setIdx]=useState(0);const [done,setDone]=useState({}); const step=sku.workflow[idx]; const progress=useMemo(()=>`${idx+1}/${sku.workflow.length}`,[idx]); return <Card className='max-w-2xl'>
  <p className='text-xs text-slate-500'>Operator Mode · Step {progress}</p>
  <h2 className='text-lg font-semibold mt-1'>{step.step}</h2>
  <div className='mt-4 grid sm:grid-cols-3 gap-3 text-sm'>
    <div className='p-3 rounded-xl bg-slate-50 border'><b>Target</b><br/>{step.target}</div>
    <div className='p-3 rounded-xl bg-slate-50 border'><b>Tool</b><br/>{step.tool}</div>
    <div className='p-3 rounded-xl bg-slate-50 border'><b>Timer</b><br/>{step.timer} sec</div>
  </div>
  <label className='mt-4 flex items-center gap-2 text-sm'><input type='checkbox' checked={!!done[idx]} onChange={e=>setDone({...done,[idx]:e.target.checked})}/> Mark step complete</label>
  <div className='mt-5 flex gap-2'>
    <button className='px-4 py-2 rounded-lg border' onClick={()=>setIdx(Math.max(0,idx-1))}>Back</button>
    <button className='px-4 py-2 rounded-lg bg-slate-900 text-white' onClick={()=>setIdx(Math.min(sku.workflow.length-1,idx+1))}>Next</button>
  </div>
</Card>}

const Placeholder=({title})=><Card><h2 className='text-lg font-semibold'>{title}</h2><p className='text-sm text-slate-600 mt-2'>Mock stainless-lab module ready for {title.toLowerCase()}.</p></Card>

function App(){return <BrowserRouter><Layout><Routes>
  <Route path='/' element={<Dashboard/>} />
  <Route path='/sku-library' element={<Placeholder title='SKU Library'/>} />
  <Route path='/sku-detail' element={<SkuDetail/>} />
  <Route path='/operator-mode' element={<OperatorMode/>} />
  <Route path='/ingredient-inventory' element={<Placeholder title='Ingredient Inventory'/>} />
  <Route path='/motion-library' element={<Placeholder title='Motion Library'/>} />
  <Route path='/media-library' element={<Placeholder title='Media Library'/>} />
  <Route path='/variant-builder' element={<Placeholder title='Variant Builder'/>} />
</Routes></Layout></BrowserRouter>}

createRoot(document.getElementById('root')).render(<App />)
