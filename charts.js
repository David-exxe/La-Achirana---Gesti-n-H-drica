// ============================================
// CHARTS.JS - Gráficos Inteligentes Hídricos
// Chart.js + ApexCharts Integración Premium
// ============================================

class HidricoCharts {
    constructor() {
        this.charts = new Map();
        // No auto-init, will be called from script.js
    }

    init() {
        this.setupResponsive();
    }

    setupResponsive() {
        window.addEventListener('resize', () => {
            this.charts.forEach(chart => {
                if (chart.chart) chart.chart.resize();
                if (chart.apex) chart.apex.updateOptions({ responsive: this.getResponsiveOptions() });
            });
        });
    }

    // Gráfico Principal Dashboard
    createDashboardChart(canvasId, data) {
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx) return;

        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, 'rgba(14, 165, 233, 0.4)');
        gradient.addColorStop(1, 'rgba(14, 165, 233, 0.05)');

        const chartConfig = {
            type: 'line',
            data: {
                labels: data.labels || ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun'],
                datasets: [{
                    label: 'Caudal (LPS)',
                    data: data.values || [12, 15, 13, 18, 16, 20],
                    borderColor: '#0ea5e9',
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    pointBackgroundColor: '#0ea5e9',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 3,
                    pointRadius: 8,
                    pointHoverRadius: 10,
                    borderWidth: 3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { 
                        display: false,
                        labels: { usePointStyle: true }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.95)',
                        titleColor: 'white',
                        bodyColor: 'white',
                        borderColor: '#0ea5e9',
                        borderWidth: 1,
                        cornerRadius: 12,
                        displayColors: false,
                        callbacks: {
                            label: function(context) {
                                return `Caudal: ${context.parsed.y} LPS`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: 'rgba(100, 116, 139, 0.6)' }
                    },
                    y: {
                        beginAtZero: true,
                        grid: { 
                            color: 'rgba(14, 165, 233, 0.1)',
                            drawBorder: false
                        },
                        ticks: { 
                            color: 'rgba(100, 116, 139, 0.6)',
                            callback: value => value + ' LPS'
                        }
                    }
                },
                animation: {
                    duration: 2000,
                    easing: 'easeInOutQuart'
                },
                interaction: {
                    intersect: false,
                    mode: 'index'
                }
            }
        };

        const chart = new Chart(ctx, chartConfig);
        this.charts.set(canvasId, { chart });
        return chart;
    }

    // Gráfico de Barras Histórico
    createBarChart(canvasId, data) {
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx) return;

        const chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.labels || ['Sem 1', 'Sem 2', 'Sem 3', 'Sem 4'],
                datasets: [{
                    label: 'Consumo Semanal (m³)',
                    data: data.values || [12500, 14800, 13200, 16700],
                    backgroundColor: [
                        'rgba(14, 165, 233, 0.8)',
                        'rgba(16, 185, 129, 0.8)',
                        'rgba(139, 92, 246, 0.8)',
                        'rgba(245, 158, 11, 0.8)'
                    ],
                    borderRadius: 12,
                    borderSkipped: false,
                    borderWidth: 2,
                    borderColor: 'rgba(255, 255, 255, 0.3)'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(0,0,0,0.05)' },
                        ticks: { callback: value => (value/1000) + 'K m³' }
                    }
                }
            }
        });

        this.charts.set(canvasId, { chart });
    }

    // ApexCharts para Proyecciones (más avanzado)
    createProyeccionChart(containerId, data) {
        const options = {
            series: [{
                name: 'Proyección',
                data: data.proyeccion || [12, 11.5, 10.8, 9.5, 8.2]
            }, {
                name: 'Necesidad',
                data: data.necesidad || [12, 12, 12, 12, 12]
            }],
            chart: {
                type: 'area',
                height: 350,
                toolbar: { show: false },
                zoom: { enabled: false }
            },
            dataLabels: { enabled: false },
            stroke: {
                curve: 'smooth',
                width: 3
            },
            xaxis: {
                categories: data.labels || ['Hoy', '+7d', '+14d', '+30d', '+60d'],
                axisBorder: { show: false },
                axisTicks: { show: false }
            },
            yaxis: {
                labels: { formatter: value => value + ' LPS' }
            },
            fill: {
                type: 'gradient',
                gradient: {
                    shadeIntensity: 1,
                    opacityFrom: 0.4,
                    opacityTo: 0.1,
                    stops: [0, 100]
                }
            },
            legend: {
                position: 'top',
                horizontalAlign: 'right',
                fontSize: '14px',
                markers: { radius: 6 }
            },
            colors: ['#8b5cf6', '#ef4444'],
            grid: {
                borderColor: 'rgba(0,0,0,0.1)',
                strokeDashArray: 3
            },
            responsive: this.getResponsiveOptions()
        };

        const chart = new ApexCharts(document.querySelector(`#${containerId}`), options);
        chart.render();
        this.charts.set(containerId, { apex: chart });
    }

    // KPI Gauge Charts
    createGaugeChart(canvasId, value, max = 100) {
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx) return;

        const percentage = (value / max) * 100;
        const gradient = ctx.createRadialGradient(150, 150, 0, 150, 150, 200);
        gradient.addColorStop(0, '#10b981');
        gradient.addColorStop(0.5, '#059669');
        gradient.addColorStop(1, 'rgba(16, 185, 129, 0.1)');

        new Chart(ctx, {
            type: 'doughnut',
            data: {
                datasets: [{
                    data: [percentage, 100 - percentage],
                    backgroundColor: [gradient, 'rgba(209, 213, 219, 0.3)'],
                    borderWidth: 0,
                    cutout: '85%'
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                },
                animation: {
                    animateRotate: true,
                    duration: 2000
                }
            }
        });
    }

    // Actualizar datos dinámicos
    updateChart(canvasId, newData) {
        const chartData = this.charts.get(canvasId);
        if (chartData?.chart) {
            chartData.chart.data.datasets[0].data = newData;
            chartData.chart.update('none');
        }
    }

    getResponsiveOptions() {
        return [{
            breakpoint: 480,
            options: {
                chart: { height: 280 },
                legend: { position: 'bottom' }
            }
        }];
    }

    // Inicializar todos los gráficos del dashboard
    createDashboardCharts() {
        // Gráfico principal
        this.createDashboardChart('graficoLineal', {
            labels: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun'],
            values: [12, 15, 13, 18, 16, 20]
        });

        // Gráfico actual
        this.createGaugeChart('graficoActual', 75, 100);

        // Gráfico proyecciones ApexCharts
        setTimeout(() => {
            this.createProyeccionChart('graficoProyeccion', {
                labels: ['Hoy', '+7d', '+14d', '+30d', '+60d'],
                proyeccion: [12, 11.5, 10.8, 9.5, 8.2],
                necesidad: [12, 12, 12, 12, 12]
            });
        }, 500);
    }
}

// Inicializar Charts globalmente
let hidricoCharts;
document.addEventListener('DOMContentLoaded', () => {
    hidricoCharts = new HidricoCharts();
});

// Funciones globales para actualizar desde app principal
window.updateHidricoChart = (canvasId, data) => {
    if (hidricoCharts) hidricoCharts.updateChart(canvasId, data);
};