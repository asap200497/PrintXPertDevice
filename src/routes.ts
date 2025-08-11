import {Router} from 'express';

const router = Router();

router.get('/teste', (req,res) => {
    return res.json({ok: true});
})

export { router } 