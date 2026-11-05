export function createMotionStudio({api,token,notice}) {
 const $=id=>document.getElementById(id),source=$('motion-source-video'),draft=$('motion-draft-video');let urls=[],job=null,loading=false,loadController=null;
 const dispose=()=>{loadController?.abort();for(const video of [source,draft]){video.pause();video.removeAttribute('src');video.load();}for(const url of urls)URL.revokeObjectURL(url);urls=[];};
 async function loadVideo(video,path) {const response=await fetch('/api/motion-media?path='+encodeURIComponent(path),{headers:{authorization:'Bearer '+token},signal:loadController.signal});if(!response.ok)throw new Error((await response.json()).error);const url=URL.createObjectURL(await response.blob());urls.push(url);video.src=url;}
 $('motion-load').onclick=async()=>{if(loading)return;loading=true;$('motion-load').disabled=true;const sourcePath=$('motion-source').value,draftPath=$('motion-draft').value;try{dispose();loadController=new AbortController();await loadVideo(source,sourcePath);await loadVideo(draft,draftPath);$('motion-status').textContent='Loaded. Source controls play, pause and seek both videos. Audio comes from source only.';}catch(e){dispose();if(e.name!=='AbortError')notice(e.message);}finally{loading=false;$('motion-load').disabled=false;}};
 source.onplay=()=>{draft.currentTime=Math.min(source.currentTime,draft.duration||source.currentTime);draft.play().catch(()=>{source.pause();notice('Draft playback is unavailable. Check its format.');});};
 source.onpause=()=>draft.pause();source.onseeking=()=>{if(Number.isFinite(draft.duration))draft.currentTime=Math.min(source.currentTime,draft.duration);};
 source.onratechange=()=>{draft.playbackRate=source.playbackRate;};
 source.ontimeupdate=()=>{if(Number.isFinite(draft.duration)&&Math.abs(draft.currentTime-source.currentTime)>.15)draft.currentTime=Math.min(source.currentTime,draft.duration);};
 draft.onended=()=>source.pause();
 async function start(kind,input) {if(job)throw new Error('Wait for the current render or cancel it.');const r=await api('motion','POST',{kind,input,approved:true});job=r.id;$('motion-cancel').disabled=false;$('motion-status').textContent='Rendering…';}
 $('motion-export').onclick=async()=>{try{if(!confirm('Render a new side-by-side MP4 using local FFmpeg? Originals are preserved; only source audio is included.'))return;await start('comparison',{source:$('motion-source').value,draft:$('motion-draft').value,seconds:Number($('motion-seconds').value)});}catch(e){notice(e.message);}};
 $('animation-render').onclick=async()=>{try{if(!confirm('Run this Python scene and its imports with your account permissions? Review the code first. This is host code execution.'))return;await start('animation',{script:$('animation-script').value,scene:$('animation-scene').value,executable:$('animation-executable').value});}catch(e){notice(e.message);}};
 $('motion-cancel').onclick=async()=>{if(job)await api('cancel','POST',{id:job});};
 function update(jobs) {if(!job)return;const current=jobs.find(j=>j.id===job);if(!current||current.status==='running')return;$('motion-status').textContent=current.error||('Rendered: '+current.output);if(current.output){$('motion-draft').value=current.output;}$('motion-cancel').disabled=true;job=null;}
 window.addEventListener('beforeunload',dispose);return {update};
}
