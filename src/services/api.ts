import axios from 'axios'

const x = process.env.NEXT_PUBLIC_API;
console.log(process.env.NEXT_PUBLIC_API);
export const api = axios.create( {
    baseURL: process.env.NEXT_PUBLIC_API as string
}    
)



