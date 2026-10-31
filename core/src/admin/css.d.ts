// CSS импортируется как текст (`with { type: 'text' }`). В типах Bun такого
// объявления нет - добавляем, иначе tsc не находит модуль.
declare module '*.css' {
  const text: string
  export default text
}
