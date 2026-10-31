// Copy a local Nebius key without printing it or overwriting another configured key.
const fs=require('node:fs');
const path=require('node:path');
const dotenv=require('dotenv');
try {
 const source=process.argv[2];
 if(!source)throw new Error('Provide the path to the existing Nebius .env file.');
 const key=dotenv.parse(fs.readFileSync(source)).NEBIUS_API_KEY;
 if(!key||!/^[-A-Za-z0-9._~+/=]+$/.test(key))throw new Error('The source does not contain a valid NEBIUS_API_KEY.');
 const target=path.join(process.cwd(),'.env');
 if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('The destination .env is a symbolic link; edit it manually.');
 let content=fs.existsSync(target)?fs.readFileSync(target,'utf8'):fs.readFileSync(path.join(__dirname,'..','.env.example'),'utf8');
 const current=dotenv.parse(content).NEBIUS_API_KEY;
 if(current&&current.trim())throw new Error('The destination already has a Nebius key; it was not changed.');
 const line=`NEBIUS_API_KEY=${key}`;
 const pattern=/^[ \t]*(?:export[ \t]+)?NEBIUS_API_KEY[ \t]*=.*$/gm;
 if(pattern.test(content))content=content.replace(pattern,line);
 else content=`${content.replace(/\s*$/,'')}\n${line}\n`;
 const temporary=`${target}.tmp-${process.pid}`;
 try{fs.writeFileSync(temporary,content,{mode:0o600,flag:'wx'});fs.chmodSync(temporary,0o600);fs.renameSync(temporary,target)}catch(error){try{fs.unlinkSync(temporary)}catch{}throw error}
 console.log('Nebius key saved to .env. Restart Stacha to load it.');
} catch(error) {
 console.error(`Could not save the Nebius key: ${error.message}`);
 process.exitCode=1;
}
