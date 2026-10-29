import { on } from 'mabase'
import missing from 'does-not-exist'
on('x', () => missing)
