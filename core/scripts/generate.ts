// Генерация src/generated/* перед typecheck и тестами: в чистом клоне этих
// файлов нет (они в .gitignore), а без них не проходят ни tsc (импорты
// generated/*), ни тесты (сервер отдаёт SDK и админку из них).
import { generate } from '../src/generate'

const { sdk } = await generate()
console.log(`Сгенерировано: src/generated (SDK ${(sdk.length / 1024).toFixed(0)} КБ)`)
