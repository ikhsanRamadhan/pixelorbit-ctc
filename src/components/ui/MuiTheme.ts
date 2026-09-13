import { createTheme } from "@mui/material";

const darkTheme = createTheme({
    palette: {
        mode: 'dark',
        primary: { main: '#06b6d4' },
    },
    components: {
        MuiPaginationItem: {
            styleOverrides: {
                root: {
                    color: '#22d3ee',
                    fontFamily: 'monospace',
                    '&.Mui-selected': {
                        backgroundColor: 'rgba(6, 182, 212, 0.2)',
                    }
                }
            }
        }
    }
});

export default darkTheme;