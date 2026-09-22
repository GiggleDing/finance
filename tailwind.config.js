/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#1A1A1A',
          700: '#3D3D3D',
          500: '#6B6B6B',
          400: '#8A8A8A',
          300: '#A3A3A3',
          200: '#D4D4D0',
          100: '#E8E8E4',
          50: '#F7F7F5',
        },
        expense: '#C2410C',
        income: '#15803D',
        accent: '#1D4ED8',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
      },
      fontSize: {
        '2xs': ['11px', '16px'],
      },
    },
  },
  plugins: [],
}
