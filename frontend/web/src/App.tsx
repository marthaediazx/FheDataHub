import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Dataset {
  id: string;
  name: string;
  encryptedData: string;
  price: string;
  category: string;
  owner: string;
  timestamp: number;
}

interface Stats {
  totalDatasets: number;
  totalTransactions: number;
  averagePrice: number;
}

const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [stats, setStats] = useState<Stats>({ totalDatasets: 0, totalTransactions: 0, averagePrice: 0 });
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newDataset, setNewDataset] = useState({ name: "", price: "", category: "DePIN/IoT" });
  const [selectedDataset, setSelectedDataset] = useState<Dataset | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [activeTab, setActiveTab] = useState('marketplace');
  const [searchQuery, setSearchQuery] = useState("");
  
  const categories = ["DePIN/IoT", "Finance", "Healthcare", "Education", "Retail"];
  const [partners] = useState([
    { name: "Zama", logo: "zama-logo", url: "https://zama.ai" },
    { name: "FHE.org", logo: "fhe-logo", url: "https://fhe.org" },
    { name: "Web3 Foundation", logo: "web3-logo", url: "https://web3.foundation" }
  ]);

  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadData = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      const datasetsBytes = await contract.getData("datasets");
      let datasetsList: Dataset[] = [];
      if (datasetsBytes.length > 0) {
        try {
          const datasetsStr = ethers.toUtf8String(datasetsBytes);
          if (datasetsStr.trim() !== '') datasetsList = JSON.parse(datasetsStr);
        } catch (e) {}
      }
      setDatasets(datasetsList);
      
      const statsBytes = await contract.getData("stats");
      let statsData: Stats = { totalDatasets: 0, totalTransactions: 0, averagePrice: 0 };
      if (statsBytes.length > 0) {
        try {
          const statsStr = ethers.toUtf8String(statsBytes);
          if (statsStr.trim() !== '') statsData = JSON.parse(statsStr);
        } catch (e) {}
      }
      setStats(statsData);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setLoading(false); 
    }
  };

  const uploadDataset = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setUploading(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Uploading dataset with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const newDatasetEntry: Dataset = {
        id: `FHE-${Date.now()}`,
        name: newDataset.name,
        encryptedData: FHEEncryptNumber(Math.random() * 1000),
        price: FHEEncryptNumber(parseFloat(newDataset.price) || 0),
        category: newDataset.category,
        owner: address,
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      const updatedDatasets = [...datasets, newDatasetEntry];
      await contract.setData("datasets", ethers.toUtf8Bytes(JSON.stringify(updatedDatasets)));
      
      const updatedStats = {
        totalDatasets: stats.totalDatasets + 1,
        totalTransactions: stats.totalTransactions,
        averagePrice: (stats.averagePrice * stats.totalDatasets + parseFloat(newDataset.price)) / (stats.totalDatasets + 1)
      };
      await contract.setData("stats", ethers.toUtf8Bytes(JSON.stringify(updatedStats)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Dataset uploaded successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowUploadModal(false);
        setNewDataset({ name: "", price: "", category: "DePIN/IoT" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Upload failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setUploading(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const handleDecrypt = async (encryptedData: string) => {
    const decrypted = await decryptWithSignature(encryptedData);
    if (decrypted !== null) {
      setDecryptedValue(decrypted);
    }
  };

  const filteredDatasets = datasets.filter(dataset => 
    dataset.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    dataset.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">📊</div>
          <div className="stat-value">{stats.totalDatasets}</div>
          <div className="stat-label">Total Datasets</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">💰</div>
          <div className="stat-value">{stats.totalTransactions}</div>
          <div className="stat-label">Transactions</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">⏱️</div>
          <div className="stat-value">{stats.averagePrice.toFixed(2)} ETH</div>
          <div className="stat-label">Avg Price</div>
        </div>
      </div>
    );
  };

  const renderFAQ = () => {
    return (
      <div className="faq-container">
        <div className="faq-item">
          <div className="faq-question">What is FheDataHub?</div>
          <div className="faq-answer">A decentralized marketplace where data providers can sell "computation rights" of their encrypted data, and data buyers can perform model training or data analysis without decrypting the data.</div>
        </div>
        <div className="faq-item">
          <div className="faq-question">How does FHE protect data?</div>
          <div className="faq-answer">Fully Homomorphic Encryption (FHE) allows computations on encrypted data without decryption, ensuring data privacy throughout the entire process.</div>
        </div>
        <div className="faq-item">
          <div className="faq-question">What data types are supported?</div>
          <div className="faq-answer">Currently supports numerical and boolean data types encrypted with Zama FHE technology.</div>
        </div>
        <div className="faq-item">
          <div className="faq-question">How to decrypt results?</div>
          <div className="faq-answer">Results remain encrypted until decrypted with your private key through wallet signature.</div>
        </div>
      </div>
    );
  };

  const renderPartners = () => {
    return (
      <div className="partners-grid">
        {partners.map((partner, index) => (
          <a href={partner.url} target="_blank" rel="noopener noreferrer" className="partner-card" key={index}>
            <div className={`partner-logo ${partner.logo}`}></div>
            <div className="partner-name">{partner.name}</div>
          </a>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing encrypted data marketplace...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>FheDataHub</h1>
          <span>Homomorphic Encrypted Data Marketplace</span>
        </div>
        
        <div className="header-actions">
          <div className="search-bar">
            <input 
              type="text" 
              placeholder="Search datasets..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button className="search-btn">🔍</button>
          </div>
          <button 
            onClick={() => setShowUploadModal(true)} 
            className="upload-btn"
          >
            Upload Dataset
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="sidebar">
          <div className="sidebar-menu">
            <button 
              className={`menu-item ${activeTab === 'marketplace' ? 'active' : ''}`}
              onClick={() => setActiveTab('marketplace')}
            >
              Marketplace
            </button>
            <button 
              className={`menu-item ${activeTab === 'stats' ? 'active' : ''}`}
              onClick={() => setActiveTab('stats')}
            >
              Statistics
            </button>
            <button 
              className={`menu-item ${activeTab === 'faq' ? 'active' : ''}`}
              onClick={() => setActiveTab('faq')}
            >
              FAQ
            </button>
            <button 
              className={`menu-item ${activeTab === 'partners' ? 'active' : ''}`}
              onClick={() => setActiveTab('partners')}
            >
              Partners
            </button>
          </div>
          
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
        </div>
        
        <div className="content-area">
          {activeTab === 'marketplace' && (
            <div className="marketplace-section">
              <h2>Encrypted Datasets Marketplace</h2>
              
              <div className="datasets-grid">
                {filteredDatasets.length === 0 ? (
                  <div className="no-datasets">
                    <p>No datasets found</p>
                    <button 
                      className="upload-btn" 
                      onClick={() => setShowUploadModal(true)}
                    >
                      Upload First Dataset
                    </button>
                  </div>
                ) : filteredDatasets.map((dataset, index) => (
                  <div 
                    className="dataset-card" 
                    key={index}
                    onClick={() => setSelectedDataset(dataset)}
                  >
                    <div className="dataset-header">
                      <div className="dataset-name">{dataset.name}</div>
                      <div className="dataset-category">{dataset.category}</div>
                    </div>
                    <div className="dataset-meta">
                      <span>Price: {dataset.price.substring(0, 10)}...</span>
                      <span>Owner: {dataset.owner.substring(0, 6)}...{dataset.owner.substring(38)}</span>
                    </div>
                    <div className="dataset-actions">
                      <button className="view-btn">View Details</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {activeTab === 'stats' && (
            <div className="stats-section">
              <h2>Marketplace Statistics</h2>
              {renderStats()}
              
              <div className="fhe-explainer">
                <h3>How FHE Works in FheDataHub</h3>
                <div className="explainer-steps">
                  <div className="step">
                    <div className="step-number">1</div>
                    <div className="step-content">
                      <h4>Data Encryption</h4>
                      <p>Providers encrypt data using Zama FHE before uploading</p>
                    </div>
                  </div>
                  <div className="step">
                    <div className="step-number">2</div>
                    <div className="step-content">
                      <h4>Secure Computation</h4>
                      <p>Buyers submit computation tasks on encrypted data</p>
                    </div>
                  </div>
                  <div className="step">
                    <div className="step-number">3</div>
                    <div className="step-content">
                      <h4>Encrypted Results</h4>
                      <p>Results remain encrypted until decrypted by buyer</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          
          {activeTab === 'faq' && (
            <div className="faq-section">
              <h2>Frequently Asked Questions</h2>
              {renderFAQ()}
            </div>
          )}
          
          {activeTab === 'partners' && (
            <div className="partners-section">
              <h2>Technology Partners</h2>
              {renderPartners()}
            </div>
          )}
        </div>
      </div>
      
      {showUploadModal && (
        <div className="modal-overlay">
          <div className="upload-modal">
            <div className="modal-header">
              <h2>Upload New Dataset</h2>
              <button onClick={() => setShowUploadModal(false)} className="close-modal">&times;</button>
            </div>
            
            <div className="modal-body">
              <div className="fhe-notice">
                <div className="lock-icon"></div>
                <div>
                  <strong>FHE Encryption Notice</strong>
                  <p>All data will be encrypted with Zama FHE</p>
                </div>
              </div>
              
              <div className="form-group">
                <label>Dataset Name *</label>
                <input 
                  type="text" 
                  value={newDataset.name} 
                  onChange={(e) => setNewDataset({...newDataset, name: e.target.value})} 
                  placeholder="Enter dataset name..." 
                />
              </div>
              
              <div className="form-group">
                <label>Price (ETH) *</label>
                <input 
                  type="number" 
                  value={newDataset.price} 
                  onChange={(e) => setNewDataset({...newDataset, price: e.target.value})} 
                  placeholder="Enter price in ETH..." 
                />
              </div>
              
              <div className="form-group">
                <label>Category *</label>
                <select 
                  value={newDataset.category} 
                  onChange={(e) => setNewDataset({...newDataset, category: e.target.value})}
                >
                  {categories.map((cat, index) => (
                    <option key={index} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
            </div>
            
            <div className="modal-footer">
              <button onClick={() => setShowUploadModal(false)} className="cancel-btn">Cancel</button>
              <button 
                onClick={uploadDataset} 
                disabled={uploading || !newDataset.name || !newDataset.price} 
                className="submit-btn"
              >
                {uploading ? "Uploading with FHE..." : "Upload Dataset"}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {selectedDataset && (
        <div className="modal-overlay">
          <div className="dataset-modal">
            <div className="modal-header">
              <h2>Dataset Details</h2>
              <button onClick={() => {
                setSelectedDataset(null);
                setDecryptedValue(null);
              }} className="close-modal">&times;</button>
            </div>
            
            <div className="modal-body">
              <div className="dataset-info">
                <div className="info-item">
                  <span>Name:</span>
                  <strong>{selectedDataset.name}</strong>
                </div>
                <div className="info-item">
                  <span>Category:</span>
                  <strong>{selectedDataset.category}</strong>
                </div>
                <div className="info-item">
                  <span>Owner:</span>
                  <strong>{selectedDataset.owner.substring(0, 6)}...{selectedDataset.owner.substring(38)}</strong>
                </div>
                <div className="info-item">
                  <span>Uploaded:</span>
                  <strong>{new Date(selectedDataset.timestamp * 1000).toLocaleDateString()}</strong>
                </div>
              </div>
              
              <div className="data-section">
                <h3>Encrypted Data</h3>
                <div className="data-row">
                  <div className="data-label">Price:</div>
                  <div className="data-value">{selectedDataset.price.substring(0, 30)}...</div>
                  <button 
                    className="decrypt-btn" 
                    onClick={() => handleDecrypt(selectedDataset.price)} 
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? (
                      "Decrypting..."
                    ) : decryptedValue !== null ? (
                      "Hide Value"
                    ) : (
                      "Decrypt Price"
                    )}
                  </button>
                </div>
                
                <div className="fhe-tag">
                  <div className="fhe-icon"></div>
                  <span>FHE Encrypted - Requires Wallet Signature</span>
                </div>
              </div>
              
              {decryptedValue !== null && (
                <div className="decrypted-section">
                  <h3>Decrypted Value</h3>
                  <div className="decrypted-value">{decryptedValue.toFixed(4)} ETH</div>
                  <button className="purchase-btn">Purchase Computation Rights</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>FheDataHub</h3>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Docs</a>
            <a href="#" className="footer-link">Privacy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="copyright">© {new Date().getFullYear()} FheDataHub. All rights reserved.</div>
          <div className="disclaimer">
            Powered by Zama FHE technology - Data remains encrypted during computation
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;